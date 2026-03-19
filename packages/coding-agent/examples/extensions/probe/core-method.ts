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

function renderCoreMethodPayload(payload: {
	query: string;
	search_execution: ProbeSearchPayload["execution"];
	primary_candidate?: ProbeSearchPayload["candidates"][number];
	supporting_candidates: ProbeSearchPayload["candidates"];
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
			"Find the most likely core execution method for a business concept. This is a higher-level workflow specialized for controller/route/dispatch/service chains and returns a primary candidate plus extracted evidence.",
		promptSnippet:
			"High-level core method locator for business workflows; use this instead of manual probe_search parameter tuning when the task is to find the main execution path.",
		promptGuidelines: [
			"Use this when the user asks which method, handler, or service is the core execution path for a business flow.",
			"If the module boundary is known, pass module_hint and prefer module_scope=strict.",
		],
		parameters: ProbeCoreMethodParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const moduleHint = params.module_hint ?? [];
			const moduleScope = params.module_scope ?? (moduleHint.length > 0 ? "strict" : "prefer");
			const searchResult = await executeProbeSearch(
				pi,
				{
					query: params.query,
					path: params.path,
					reranker: "hybrid",
					auto_retry_reranker: true,
					intent: "core_method",
					module_hint: moduleHint,
					module_scope: moduleScope,
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
				return searchResult;
			}

			const primaryCandidate = payload.candidates[0];
			let primaryExtract: string | undefined;

			if (primaryCandidate) {
				const extractResult = await runProbe(
					pi,
					"extract",
					[primaryCandidate.extract_target],
					normalizeOptionalString(params.path) ?? ctx.cwd,
					signal,
				);
				primaryExtract = extractResult.content[0]?.text;
			}

			const output = renderCoreMethodPayload({
				query: params.query,
				search_execution: payload.execution,
				primary_candidate: primaryCandidate,
				supporting_candidates: payload.candidates.slice(1),
				primary_extract: primaryExtract,
				recommended_next_actions: [
					...(payload.suggestions ?? []),
					primaryCandidate?.upstream_routes?.length
						? "Follow the upstream route or funCode carrier next if you need entrypoint proof."
						: "Search for the nearest controller/route declaration next if you need entrypoint proof.",
					primaryCandidate?.downstream_calls?.length
						? "Inspect the first downstream service/dao call for execution proof."
						: "Inspect the nearest service implementation for downstream execution proof.",
				],
			});
			const truncated = truncateProbeOutput(output);

			return {
				content: [{ type: "text", text: truncated.text }],
				details: {
					query: params.query,
					path: normalizeOptionalString(params.path) ?? ctx.cwd,
					module_hint: moduleHint,
					module_scope: moduleScope,
					primary_extract_target: primaryCandidate?.extract_target,
				} satisfies ProbeCoreMethodDetails,
			};
		},
	});
}
