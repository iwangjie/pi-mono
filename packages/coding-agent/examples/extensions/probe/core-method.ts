import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { normalizeOptionalString, runProbe, truncateProbeOutput } from "./common.js";
import { executeProbeSearch, type ProbeSearchPayload } from "./search.js";

interface ProbeCoreMethodDetails {
	query: string;
	path: string;
	module_hint: string[];
	module_scope: "prefer" | "strict";
	primary_extract_target?: string;
}

interface CoreMethodWorkflowStep {
	stage: string;
	query: string;
	module_scope: "prefer" | "strict";
	returned_candidates: number;
	primary_candidate?: string;
	applied_reranker?: string;
	primary_failure_reason?: string;
	best_next_change?: string;
	source: "probe" | "rg";
}

type CoreMethodCandidate = ProbeSearchPayload["candidates"][number] & {
	source: "probe" | "rg";
	supporting_steps: string[];
};

const ProbeCoreMethodParams = Type.Object({
	query: Type.String({
		description: "Business concept or task, for example `自由职业者签约核心方法`.",
	}),
	path: Type.Optional(
		Type.String({ description: "Directory or file path to search. Defaults to the current project." }),
	),
	module_hint: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Optional module/path hints, for example ["trans-business"].',
		}),
	),
	module_scope: Type.Optional(
		Type.Union([Type.Literal("prefer"), Type.Literal("strict")], {
			description: "`prefer` boosts hinted modules. `strict` keeps final candidates inside hinted modules.",
		}),
	),
	synonym_expansion: Type.Optional(
		Type.Boolean({
			description: "Default true. Expand business synonyms before ranking.",
		}),
	),
	include_globs: Type.Optional(Type.Array(Type.String())),
	exclude_globs: Type.Optional(Type.Array(Type.String())),
	max_candidates: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum number of candidate files to keep in the search stage.",
		}),
	),
});

const CORE_QUERY_STOPWORDS = new Set(["平台", "调用", "服务", "核心", "方法", "哪个", "什么", "如何", "流程", "业务"]);

function splitCoreQueryTerms(query: string): string[] {
	return query
		.split(/[\s,，。;；:：/|()[\]{}"'`<>!?！？]+/)
		.map((term) => term.trim())
		.filter((term) => term.length >= 2)
		.slice(0, 16);
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function buildCoreMethodQueryVariants(query: string): Array<{ stage: string; query: string }> {
	const rawTerms = splitCoreQueryTerms(query);
	const focusedTerms = rawTerms.filter((term) => !CORE_QUERY_STOPWORDS.has(term)).slice(0, 4);
	const semanticTerms = [...focusedTerms];
	const chainTerms: string[] = [];

	const lowerQuery = query.toLowerCase();
	if (query.includes("自由职业者") || query.includes("灵工") || lowerQuery.includes("soho")) {
		semanticTerms.push("自由职业者", "soho");
		chainTerms.push("Soho", "SohoSign", "SignReq");
	}
	if (query.includes("服务商") || lowerQuery.includes("merchant") || lowerQuery.includes("levy")) {
		semanticTerms.push("服务商", "merchant", "levy");
	}
	if (
		query.includes("签约") ||
		query.includes("签署") ||
		lowerQuery.includes("sign") ||
		lowerQuery.includes("contract")
	) {
		semanticTerms.push("签约", "sign", "contract");
		chainTerms.push("doBusiness", "execute", "process");
	}
	if (query.includes("核心方法") || query.includes("调用") || query.includes("入口")) {
		chainTerms.push("funCode", "dispatch", "route", "controller", "service");
	}

	const focusedQuery = uniqueStrings([...focusedTerms, ...semanticTerms])
		.slice(0, 6)
		.join(" ");
	const dispatchQuery = uniqueStrings([
		...focusedTerms,
		...semanticTerms.slice(0, 3),
		"funCode",
		"dispatch",
		"route",
		"controller",
	])
		.slice(0, 7)
		.join(" ");
	const serviceQuery = uniqueStrings([
		...focusedTerms,
		...semanticTerms.slice(0, 3),
		...chainTerms,
		"doBusiness",
		"service",
	])
		.slice(0, 7)
		.join(" ");

	const variants = [
		{ stage: "focused_keywords", query: focusedQuery || rawTerms.slice(0, 4).join(" ") || query },
		{ stage: "dispatch_chain", query: dispatchQuery },
		{ stage: "service_chain", query: serviceQuery },
	];

	return variants.filter(
		(value, index, array) =>
			value.query.length > 0 && array.findIndex((candidate) => candidate.query === value.query) === index,
	);
}

function mergeExplain(base: string[], next: string[]): string[] {
	return Array.from(new Set([...base, ...next])).slice(0, 8);
}

function mergeSuggestions(values: string[]): string[] {
	return Array.from(new Set(values)).slice(0, 6);
}

function candidateStrength(candidate: CoreMethodCandidate | undefined): number {
	if (!candidate) {
		return -1;
	}
	const confidenceWeight = candidate.confidence === "high" ? 30 : candidate.confidence === "medium" ? 15 : 0;
	const routeWeight = (candidate.upstream_routes?.length ?? 0) * 4;
	const downstreamWeight = (candidate.downstream_calls?.length ?? 0) * 2;
	return candidate.score + confidenceWeight + routeWeight + downstreamWeight;
}

function mergeCoreMethodCandidate(
	existing: CoreMethodCandidate | undefined,
	candidate: ProbeSearchPayload["candidates"][number],
	stage: string,
	scoreBoost: number,
): CoreMethodCandidate {
	const boostedScore = candidate.score + scoreBoost;
	if (!existing) {
		return {
			...candidate,
			score: boostedScore,
			source: "probe",
			supporting_steps: [stage],
			explain: mergeExplain(candidate.explain, [`workflow stage: ${stage}`]),
		};
	}

	const merged: CoreMethodCandidate = {
		...existing,
		score: Math.max(existing.score, boostedScore) + 2,
		confidence:
			existing.confidence === "high" || candidate.confidence === "high"
				? "high"
				: existing.confidence === "medium" || candidate.confidence === "medium"
					? "medium"
					: "low",
		matched_terms: Array.from(new Set([...existing.matched_terms, ...candidate.matched_terms])),
		explain: mergeExplain(existing.explain, [...candidate.explain, `workflow stage: ${stage}`]),
		why_this_is_core: mergeExplain(existing.why_this_is_core ?? [], candidate.why_this_is_core ?? []),
		upstream_routes: mergeSuggestions([...(existing.upstream_routes ?? []), ...(candidate.upstream_routes ?? [])]),
		downstream_calls: mergeSuggestions([...(existing.downstream_calls ?? []), ...(candidate.downstream_calls ?? [])]),
		snippets: [...existing.snippets, ...candidate.snippets].slice(0, 2),
		supporting_steps: mergeSuggestions([...existing.supporting_steps, stage]),
	};

	if (
		candidateStrength({
			...candidate,
			score: boostedScore,
			source: "probe",
			supporting_steps: [stage],
		}) > candidateStrength(existing)
	) {
		merged.best_span = candidate.best_span;
		merged.extract_target = candidate.extract_target;
		merged.likely_primary_method = candidate.likely_primary_method ?? existing.likely_primary_method;
		merged.call_chain_hint = candidate.call_chain_hint ?? existing.call_chain_hint;
	}

	return merged;
}

function escapeRegExp(term: string): string {
	return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runCoreMethodRgFallback(
	pi: ExtensionAPI,
	query: string,
	cwd: string,
	path: string,
	moduleHint: string[],
	moduleScope: "prefer" | "strict",
	signal: AbortSignal | undefined,
): Promise<{ candidates: CoreMethodCandidate[]; workflowStep?: CoreMethodWorkflowStep }> {
	const rawTerms = splitCoreQueryTerms(query);
	const focusedTerms = rawTerms.filter((term) => !CORE_QUERY_STOPWORDS.has(term)).slice(0, 4);
	const regexTerms = uniqueStrings([
		...focusedTerms,
		"funCode",
		"doBusiness",
		"execute",
		"dispatch",
		"process",
		"handle",
		"SignReq",
		"Soho",
		"SohoSign",
	]).map(escapeRegExp);

	if (regexTerms.length === 0) {
		return { candidates: [] };
	}

	const commandArgs = [
		"-n",
		"--no-heading",
		"--glob",
		"*.java",
		"--glob",
		"*.kt",
		"--glob",
		"*.groovy",
		"-e",
		regexTerms.join("|"),
		path,
	];

	const result = await pi.exec("rg", commandArgs, {
		cwd,
		signal,
		timeout: 30_000,
	});
	if (result.killed || result.code > 1) {
		return { candidates: [] };
	}
	if (result.code === 1 || !result.stdout.trim()) {
		return { candidates: [] };
	}

	const candidatesByFile = new Map<string, CoreMethodCandidate>();
	for (const line of result.stdout.split("\n")) {
		const match = line.match(/^(.+?):(\d+):(.*)$/);
		if (!match) {
			continue;
		}
		const file = match[1];
		const lineNumber = Number(match[2]);
		const preview = match[3].trim();
		const fileLower = file.toLowerCase();
		if (
			moduleScope === "strict" &&
			moduleHint.length > 0 &&
			!moduleHint.some((hint) => fileLower.includes(hint.toLowerCase()))
		) {
			continue;
		}

		const matchedTerms = focusedTerms.filter((term) => preview.includes(term) || file.includes(term));
		let score = 8 + matchedTerms.length * 4;
		const explain = ["rg fallback matched structural or business markers"];
		if (moduleHint.some((hint) => fileLower.includes(hint.toLowerCase()))) {
			score += 10;
			explain.push("module hint matched");
		}
		if (/controller|router|handler/i.test(file)) {
			score += 6;
			explain.push("entrypoint path hint");
		}
		if (/service|serviceimpl|manager|processor|executor|biz/i.test(file)) {
			score += 8;
			explain.push("business path hint");
		}
		if (/doBusiness|execute|dispatch|process|handle/.test(preview)) {
			score += 12;
			explain.push("core-method naming hint");
		}
		if (/funCode|SignReq|Soho/i.test(preview)) {
			score += 10;
			explain.push("dispatch/request marker");
		}

		const existing = candidatesByFile.get(file);
		const candidate: CoreMethodCandidate = {
			file,
			best_span: `${file}:${lineNumber}`,
			extract_target: `${file}:${lineNumber}-${lineNumber + 30}`,
			confidence: score >= 28 ? "high" : score >= 16 ? "medium" : "low",
			score,
			matched_terms: matchedTerms,
			explain,
			likely_primary_method: /([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(preview)?.[1],
			call_chain_hint: /funCode|dispatch/.test(preview)
				? "Route/Enum -> Dispatch -> Service"
				: /doBusiness|execute|process/.test(preview)
					? "Service -> downstream processor/gateway/DAO"
					: undefined,
			why_this_is_core: explain,
			upstream_routes: /funCode/.test(preview) ? [preview] : [],
			downstream_calls: [],
			snippets: [
				{
					lines: `${lineNumber}`,
					start_line: lineNumber,
					end_line: lineNumber,
					preview,
					clipped: false,
				},
			],
			source: "rg",
			supporting_steps: ["rg_fallback"],
		};

		if (!existing || candidateStrength(candidate) > candidateStrength(existing)) {
			candidatesByFile.set(file, candidate);
		}
	}

	const candidates = Array.from(candidatesByFile.values())
		.sort((left, right) => candidateStrength(right) - candidateStrength(left))
		.slice(0, 3);

	return {
		candidates,
		workflowStep: {
			stage: "rg_fallback",
			query: regexTerms.join("|"),
			module_scope: moduleScope,
			returned_candidates: candidates.length,
			primary_candidate: candidates[0]?.file,
			source: "rg",
			primary_failure_reason:
				candidates.length > 0 ? undefined : "rg fallback did not find a structural route or execution marker.",
			best_next_change:
				candidates.length > 0
					? undefined
					: moduleHint.length > 0
						? "Give an exact class, enum, funCode, or request type inside the hinted module."
						: "Provide module_hint or a known identifier such as a class, enum, or funCode name.",
		},
	};
}

function buildRecommendedNextActions(candidate: CoreMethodCandidate | undefined, bestNextChange?: string): string[] {
	if (!candidate) {
		return [
			...(bestNextChange ? [`Best next change: ${bestNextChange}`] : []),
			"Give a module_hint if you know the bounded area, for example trans-business.",
			"Search for a concrete identifier next, such as a class name, enum item, request type, or funCode.",
		];
	}

	return [
		`Next best action: probe_extract ${candidate.extract_target}`,
		...(bestNextChange ? [`Best next change if this still looks wrong: ${bestNextChange}`] : []),
		(candidate.upstream_routes?.length ?? 0) > 0
			? "If you need entrypoint proof, extract the route, funCode carrier, or enum referenced by the candidate."
			: "If you need entrypoint proof, extract the nearest controller or dispatch carrier next.",
		(candidate.downstream_calls?.length ?? 0) > 0
			? "If you need execution proof, extract the first downstream call target next."
			: "If you need execution proof, extract the nearest service implementation or gateway call next.",
	];
}

function renderCoreMethodPayload(payload: {
	query: string;
	query_variants: Array<{ stage: string; query: string }>;
	workflow: CoreMethodWorkflowStep[];
	primary_failure_reason?: string;
	best_next_change?: string;
	primary_candidate?: CoreMethodCandidate;
	supporting_candidates: CoreMethodCandidate[];
	primary_extract?: string;
	recommended_next_actions: string[];
}): string {
	return JSON.stringify(payload, null, 2);
}

export function registerProbeCoreMethod(pi: ExtensionAPI) {
	pi.registerTool({
		name: "probe_core_method",
		label: "Probe Core Method",
		description:
			"Find the most likely core execution method for a business concept. This is an opinionated multi-stage workflow for route/controller/dispatch/service chains, with lighter defaults and stronger guidance than raw probe_search.",
		promptSnippet:
			"Default high-level workflow for finding the core execution path. Use this instead of manually tuning probe_search when the task is to identify the main method, handler, or dispatch chain.",
		promptGuidelines: [
			"Use this first when the user asks which method, handler, service, or route is the core execution path.",
			"If the module boundary is known, pass module_hint. The tool will keep the workflow simple and only tighten scope when that helps.",
		],
		parameters: ProbeCoreMethodParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = normalizeOptionalString(params.path) ?? ctx.cwd;
			const moduleHint = params.module_hint ?? [];
			const moduleScope = params.module_scope ?? (moduleHint.length > 0 ? "strict" : "prefer");
			const queryVariants = buildCoreMethodQueryVariants(params.query);
			const workflow: CoreMethodWorkflowStep[] = [];
			const mergedCandidates = new Map<string, CoreMethodCandidate>();
			let primaryFailureReason: string | undefined;
			let bestNextChange: string | undefined;

			for (const [index, variant] of queryVariants.entries()) {
				const stageModuleScope = moduleHint.length > 0 && index < 2 ? moduleScope : "prefer";
				const searchResult = await executeProbeSearch(
					pi,
					{
						query: variant.query,
						path: searchPath,
						reranker: "hybrid",
						auto_retry_reranker: true,
						intent: "core_method",
						module_hint: moduleHint,
						module_scope: stageModuleScope,
						synonym_expansion: params.synonym_expansion !== false,
						include_globs: params.include_globs,
						exclude_globs: params.exclude_globs,
						code_only: true,
						output_mode: "agent_json",
						prefer_entrypoints: true,
						max_files: params.max_candidates ?? 4,
						max_snippets_per_file: 1,
						max_lines_per_snippet: 18,
					},
					ctx.cwd,
					signal,
				);

				const payload = searchResult.payload;
				if (!payload) {
					workflow.push({
						stage: variant.stage,
						query: variant.query,
						module_scope: stageModuleScope,
						returned_candidates: 0,
						source: "probe",
					});
					continue;
				}

				workflow.push({
					stage: variant.stage,
					query: variant.query,
					module_scope: stageModuleScope,
					returned_candidates: payload.candidates.length,
					primary_candidate: payload.candidates[0]?.file,
					applied_reranker: payload.execution.applied_reranker,
					primary_failure_reason: payload.primary_failure_reason,
					best_next_change: payload.best_next_change,
					source: "probe",
				});
				primaryFailureReason ??= payload.primary_failure_reason;
				bestNextChange ??= payload.best_next_change;

				const stageBoost = queryVariants.length - index;
				for (const candidate of payload.candidates) {
					mergedCandidates.set(
						candidate.file,
						mergeCoreMethodCandidate(mergedCandidates.get(candidate.file), candidate, variant.stage, stageBoost),
					);
				}

				const currentPrimary = Array.from(mergedCandidates.values()).sort(
					(left, right) => candidateStrength(right) - candidateStrength(left),
				)[0];
				if (
					currentPrimary &&
					currentPrimary.confidence === "high" &&
					(currentPrimary.upstream_routes?.length ?? 0) > 0
				) {
					break;
				}
			}

			let rankedCandidates = Array.from(mergedCandidates.values()).sort(
				(left, right) => candidateStrength(right) - candidateStrength(left),
			);

			if (rankedCandidates.length === 0 || (rankedCandidates[0]?.confidence !== "high" && moduleHint.length > 0)) {
				const rgFallback = await runCoreMethodRgFallback(
					pi,
					params.query,
					ctx.cwd,
					searchPath,
					moduleHint,
					moduleScope,
					signal,
				);
				if (rgFallback.workflowStep) {
					workflow.push(rgFallback.workflowStep);
				}
				for (const candidate of rgFallback.candidates) {
					const existing = mergedCandidates.get(candidate.file);
					if (!existing || candidateStrength(candidate) > candidateStrength(existing)) {
						mergedCandidates.set(candidate.file, candidate);
					}
				}
				rankedCandidates = Array.from(mergedCandidates.values()).sort(
					(left, right) => candidateStrength(right) - candidateStrength(left),
				);
				if (rgFallback.workflowStep?.primary_failure_reason) {
					primaryFailureReason ??= rgFallback.workflowStep.primary_failure_reason;
				}
				if (rgFallback.workflowStep?.best_next_change) {
					bestNextChange ??= rgFallback.workflowStep.best_next_change;
				}
			}

			const primaryCandidate = rankedCandidates[0];
			let primaryExtract: string | undefined;

			if (primaryCandidate) {
				const extractResult = await runProbe(pi, "extract", [primaryCandidate.extract_target], ctx.cwd, signal);
				primaryExtract = extractResult.content[0]?.text;
			}

			const output = renderCoreMethodPayload({
				query: params.query,
				query_variants: queryVariants,
				workflow,
				primary_failure_reason: primaryFailureReason,
				best_next_change: bestNextChange,
				primary_candidate: primaryCandidate,
				supporting_candidates: rankedCandidates.slice(1, params.max_candidates ?? 4),
				primary_extract: primaryExtract,
				recommended_next_actions: buildRecommendedNextActions(primaryCandidate, bestNextChange),
			});
			const truncated = truncateProbeOutput(output);

			return {
				content: [{ type: "text", text: truncated.text }],
				details: {
					query: params.query,
					path: searchPath,
					module_hint: moduleHint,
					module_scope: moduleScope,
					primary_extract_target: primaryCandidate?.extract_target,
				} satisfies ProbeCoreMethodDetails,
			};
		},
	});
}
