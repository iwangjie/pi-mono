import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { normalizeOptionalString, type ProbeToolDetails, runProbe, truncateProbeOutput } from "./common.js";
import { loadProjectProbeSynonyms, type ProbeSynonymMap } from "./config.js";

interface ProbeSearchHit {
	file: string;
	lines: string;
	language: string;
	snippet: string;
}

interface RankedProbeSearchHit extends ProbeSearchHit {
	score: number;
	explain: string[];
}

interface ProbeSearchCandidateSnippet {
	lines: string;
	start_line: number;
	end_line: number;
	preview: string;
	clipped: boolean;
}

interface ProbeSearchCandidate {
	file: string;
	best_span: string;
	extract_target: string;
	confidence: "high" | "medium" | "low";
	score: number;
	matched_terms: string[];
	explain: string[];
	likely_primary_method?: string;
	call_chain_hint?: string;
	why_this_is_core?: string[];
	upstream_routes?: string[];
	downstream_calls?: string[];
	snippets: ProbeSearchCandidateSnippet[];
}

export interface ProbeSearchPayload {
	query: string;
	path: string;
	expanded_query?: string;
	execution: {
		strict_reranker: boolean;
		retry_strategy: string[];
		requested_reranker: string;
		applied_reranker: string;
		fallback_reason?: string;
		quality_impact: "none" | "low" | "medium" | "high";
		probe_banner?: string;
		attempts: Array<{
			requested_reranker: string;
			applied_reranker: string;
			probe_banner?: string;
			fallback_reason?: string;
			quality_impact: "none" | "low" | "medium" | "high";
		}>;
	};
	filters: {
		exact: boolean;
		any_term: boolean;
		allow_tests: boolean;
		files_only_requested: boolean;
		code_only: boolean;
		intent: "generic" | "core_method";
		synonym_expansion: boolean;
		module_hint: string[];
		module_scope: "prefer" | "strict";
		include_globs: string[];
		exclude_globs: string[];
	};
	summary: {
		raw_hits: number;
		filtered_hits: number;
		unique_files: number;
		returned_files: number;
	};
	candidates: ProbeSearchCandidate[];
	suggestions: string[];
}

const ProbeReranker = StringEnum(["hybrid", "hybrid2", "bm25", "tfidf"] as const, {
	description: "Ranking algorithm for Probe search results.",
});

const ProbeSearchOutputMode = StringEnum(["agent_json", "smart_text", "raw_text"] as const, {
	description:
		"`agent_json` returns stable machine-friendly fields. `smart_text` returns concise ranked prose. `raw_text` returns Probe's original CLI output.",
});

const ProbeSearchIntent = StringEnum(["generic", "core_method"] as const, {
	description:
		"`core_method` focuses ranking on route/controller/dispatch/service entrypoints and likely business execution methods.",
});

const ProbeModuleScope = StringEnum(["prefer", "strict"] as const, {
	description: "`prefer` boosts hinted modules. `strict` filters final candidates to hinted modules only.",
});

export const ProbeSearchParams = Type.Object({
	query: Type.String({ description: "Natural-language or keyword query to pass to `probe search`." }),
	path: Type.Optional(
		Type.String({ description: "Directory or file path to search. Defaults to the current project." }),
	),
	reranker: Type.Optional(ProbeReranker),
	auto_retry_reranker: Type.Optional(
		Type.Boolean({
			description:
				"Default true. If the requested reranker falls back, retry a small plan such as hybrid -> hybrid2 -> bm25.",
		}),
	),
	strict_reranker: Type.Optional(
		Type.Boolean({
			description: "Require the requested reranker to be applied. If Probe falls back, the tool errors.",
		}),
	),
	exact: Type.Optional(
		Type.Boolean({
			description: "Use exact matching. Good for specific method names, identifiers, or quoted phrases.",
		}),
	),
	any_term: Type.Optional(
		Type.Boolean({
			description: "Match any search term instead of requiring all terms. Useful for broad first-pass exploration.",
		}),
	),
	files_only: Type.Optional(
		Type.Boolean({
			description: "Return matching file paths only, without code blocks. Good for quick narrowing.",
		}),
	),
	allow_tests: Type.Optional(
		Type.Boolean({
			description: "Include test files in results.",
		}),
	),
	code_only: Type.Optional(
		Type.Boolean({
			description:
				"Default true. Prefer code files and drop non-code files like jsp, markdown, docs, templates, sql, and configs from final ranked output.",
		}),
	),
	module_hint: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Optional module or path hints to boost, for example ["trans-business", "merchant/service"].',
		}),
	),
	module_scope: Type.Optional(ProbeModuleScope),
	intent: Type.Optional(ProbeSearchIntent),
	synonym_expansion: Type.Optional(
		Type.Boolean({
			description:
				"Default false. Expand a small built-in business synonym set for ranking and query rewriting, for example 自由职业者 -> soho.",
		}),
	),
	include_globs: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Optional path globs to keep in tool output, for example ["**/*.java", "**/*Service*.java"].',
		}),
	),
	exclude_globs: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Optional path globs to drop from tool output, for example ["**/resources/**", "**/*.jsp"].',
		}),
	),
	smart: Type.Optional(
		Type.Boolean({
			description:
				"Default true. Re-rank and reformat Probe output for agent use: file-first summary, per-file dedupe, clipped snippets, and short explain lines.",
		}),
	),
	output_mode: Type.Optional(ProbeSearchOutputMode),
	prefer_entrypoints: Type.Optional(
		Type.Boolean({
			description:
				"Default true. Prefer likely entrypoint and orchestration files such as controllers, routers, handlers, services, and main business methods.",
		}),
	),
	max_files: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum number of unique files to show in smart mode.",
		}),
	),
	max_snippets_per_file: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum number of snippets to show per file in smart mode.",
		}),
	),
	max_lines_per_snippet: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum lines to show for each snippet in smart mode before clipping.",
		}),
	),
	max_results: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of results to return." })),
	max_bytes: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum total bytes Probe should return before its own truncation.",
		}),
	),
	max_tokens: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum total tokens Probe should return. Useful to keep results compact.",
		}),
	),
});

export interface ProbeSearchExecuteOptions {
	query: string;
	path?: string;
	reranker?: "hybrid" | "hybrid2" | "bm25" | "tfidf";
	auto_retry_reranker?: boolean;
	strict_reranker?: boolean;
	exact?: boolean;
	any_term?: boolean;
	files_only?: boolean;
	allow_tests?: boolean;
	code_only?: boolean;
	module_hint?: string[];
	module_scope?: "prefer" | "strict";
	intent?: "generic" | "core_method";
	synonym_expansion?: boolean;
	include_globs?: string[];
	exclude_globs?: string[];
	smart?: boolean;
	output_mode?: "agent_json" | "smart_text" | "raw_text";
	prefer_entrypoints?: boolean;
	max_files?: number;
	max_snippets_per_file?: number;
	max_lines_per_snippet?: number;
	max_results?: number;
	max_bytes?: number;
	max_tokens?: number;
}

const BUILTIN_QUERY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
	自由职业者: ["soho", "灵工"],
	soho: ["自由职业者", "灵工"],
	灵工: ["自由职业者", "soho"],
	签约: ["签署", "sign", "contract", "signreq", "dobusiness"],
	签署: ["签约", "sign", "contract"],
	服务商: ["merchant", "provider"],
	levy: ["merchant", "服务商"],
	merchant: ["服务商", "levy"],
	平台: ["platform"],
};

function splitQueryTerms(query: string): string[] {
	return query
		.split(/[\s,，。;；:：/|()[\]{}"'`<>!?！？]+/)
		.map((term) => term.trim())
		.filter((term) => term.length >= 2)
		.slice(0, 12);
}

function mergeSynonyms(projectSynonyms: ProbeSynonymMap): ProbeSynonymMap {
	const merged: ProbeSynonymMap = {};

	for (const [key, values] of Object.entries(BUILTIN_QUERY_SYNONYMS)) {
		merged[key] = [...values];
	}
	for (const [key, values] of Object.entries(projectSynonyms)) {
		merged[key] = Array.from(new Set([...(merged[key] ?? []), ...values]));
	}

	return merged;
}

function expandQueryTerms(terms: string[], enabled: boolean, synonymMap: ProbeSynonymMap): string[] {
	if (!enabled) {
		return terms;
	}

	const expanded = new Set<string>(terms);
	for (const term of terms) {
		for (const [source, synonyms] of Object.entries(synonymMap)) {
			if (term.toLowerCase().includes(source.toLowerCase()) || source.toLowerCase().includes(term.toLowerCase())) {
				for (const synonym of synonyms) {
					expanded.add(synonym);
				}
			}
		}
	}
	return Array.from(expanded).slice(0, 24);
}

function countMatches(text: string, terms: string[]): number {
	const haystack = text.toLowerCase();
	let count = 0;

	for (const term of terms) {
		if (haystack.includes(term.toLowerCase())) {
			count++;
		}
	}
	return count;
}

function getMatchedTerms(text: string, terms: string[]): string[] {
	const haystack = text.toLowerCase();
	return terms.filter((term) => haystack.includes(term.toLowerCase()));
}

function isCodeFile(path: string): boolean {
	return /\.(java|kt|scala|groovy|go|rs|py|ts|tsx|js|jsx|c|cc|cpp|cs)$/i.test(path);
}

function pathHasAnyHint(path: string, hints: string[]): boolean {
	const lower = path.toLowerCase();
	return hints.some((hint) => lower.includes(hint.toLowerCase()));
}

function clipSnippet(snippet: string, maxLines: number): { text: string; clipped: boolean; totalLines: number } {
	const lines = snippet.split("\n");
	if (lines.length <= maxLines) {
		return { text: snippet, clipped: false, totalLines: lines.length };
	}
	return {
		text: `${lines.slice(0, maxLines).join("\n")}\n// ... clipped ${lines.length - maxLines} more lines`,
		clipped: true,
		totalLines: lines.length,
	};
}

function parseProbeSearchHits(output: string): {
	hits: ProbeSearchHit[];
	actualRankingLine?: string;
	foundResults?: number;
} {
	const hits: ProbeSearchHit[] = [];
	const hitPattern = /^\s*File:\s*(.+)\n\s*Lines:\s*(.+)\n\s*```([^\n]*)\n([\s\S]*?)\n\s*```/gm;

	let match = hitPattern.exec(output);
	while (match) {
		hits.push({
			file: match[1].trim(),
			lines: match[2].trim(),
			language: match[3].trim() || "text",
			snippet: match[4],
		});
		match = hitPattern.exec(output);
	}

	const actualRankingLine = output
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("Using "));

	const foundResultsMatch = output.match(/Found\s+(\d+)\s+search results/i);
	const foundResults = foundResultsMatch ? Number(foundResultsMatch[1]) : undefined;

	return { hits, actualRankingLine, foundResults };
}

function parseProbeLineRange(lines: string): { start: number; end: number } {
	const match = lines.trim().match(/^(\d+)(?:-(\d+))?$/);
	if (!match) {
		return { start: 1, end: 1 };
	}
	const start = Number(match[1]);
	const end = Number(match[2] ?? match[1]);
	return { start, end };
}

function globToRegExp(glob: string): RegExp {
	let pattern = "^";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		const next = glob[i + 1];

		if (char === "*") {
			if (next === "*") {
				pattern += ".*";
				i++;
			} else {
				pattern += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			pattern += ".";
			continue;
		}

		if ("\\.[]{}()+-^$|".includes(char)) {
			pattern += `\\${char}`;
			continue;
		}

		pattern += char;
	}
	pattern += "$";
	return new RegExp(pattern);
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
	if (globs.length === 0) {
		return false;
	}
	return globs.some((glob) => globToRegExp(glob).test(path));
}

function createExecutionAttempt(
	requestedReranker: string,
	actualRankingLine: string | undefined,
): {
	requested_reranker: string;
	applied_reranker: string;
	probe_banner?: string;
	fallback_reason?: string;
	quality_impact: ProbeSearchPayload["execution"]["quality_impact"];
} {
	const normalizedBanner = actualRankingLine?.toLowerCase() ?? "";
	let appliedReranker = requestedReranker;
	let fallbackReason: string | undefined;
	let qualityImpact: ProbeSearchPayload["execution"]["quality_impact"] = "none";

	for (const candidate of ["hybrid2", "hybrid", "bm25", "tfidf"] as const) {
		if (normalizedBanner.includes(candidate)) {
			appliedReranker = candidate;
			break;
		}
	}

	if (actualRankingLine && appliedReranker !== requestedReranker) {
		fallbackReason = `Probe banner reported ${appliedReranker} while ${requestedReranker} was requested.`;
		if (requestedReranker === "hybrid2" && (appliedReranker === "bm25" || appliedReranker === "tfidf")) {
			qualityImpact = "high";
		} else if (requestedReranker === "hybrid" && (appliedReranker === "bm25" || appliedReranker === "tfidf")) {
			qualityImpact = "medium";
		} else {
			qualityImpact = "low";
		}
	}

	return {
		requested_reranker: requestedReranker,
		applied_reranker: appliedReranker,
		fallback_reason: fallbackReason,
		quality_impact: qualityImpact,
		probe_banner: actualRankingLine,
	};
}

function buildRerankerPlan(requestedReranker: string, autoRetry: boolean): string[] {
	if (!autoRetry) {
		return [requestedReranker];
	}
	if (requestedReranker === "hybrid") {
		return ["hybrid", "hybrid2", "bm25"];
	}
	if (requestedReranker === "hybrid2") {
		return ["hybrid2", "hybrid", "bm25"];
	}
	return [requestedReranker];
}

function rankProbeSearchHit(
	hit: ProbeSearchHit,
	queryTerms: string[],
	preferEntrypoints: boolean,
	moduleHints: string[],
	intent: "generic" | "core_method",
): RankedProbeSearchHit {
	let score = 0;
	const explain: string[] = [];

	const fileLower = hit.file.toLowerCase();
	const snippetLower = hit.snippet.toLowerCase();
	const pathTermMatches = countMatches(hit.file, queryTerms);
	const snippetTermMatches = countMatches(hit.snippet, queryTerms);

	if (pathTermMatches > 0) {
		score += pathTermMatches * 6;
		explain.push(`path matched ${pathTermMatches} query term(s)`);
	}
	if (snippetTermMatches > 0) {
		score += snippetTermMatches * 3;
		explain.push(`snippet matched ${snippetTermMatches} query term(s)`);
	}

	if (isCodeFile(fileLower)) {
		score += 4;
		explain.push("code file");
	}
	if (/\.(properties|yaml|yml|toml|ini|conf|cfg)$/.test(fileLower)) {
		score -= 8;
		explain.push("config file penalty");
	}
	if (/\.(sql|jsp|html|htm|txt|md|pdf|doc|docx)$/i.test(fileLower)) {
		score -= 12;
		explain.push("non-code or document penalty");
	}
	if (moduleHints.length > 0 && pathHasAnyHint(fileLower, moduleHints)) {
		score += 12;
		explain.push("module hint boost");
	}

	if (preferEntrypoints) {
		if (/(controller|router|route|handler)/i.test(hit.file)) {
			score += 14;
			explain.push("entrypoint path hint");
		}
		if (/(service|serviceimpl|manager|processor|executor|biz)/i.test(hit.file)) {
			score += 10;
			explain.push("business path hint");
		}
		if (
			snippetLower.includes("@requestmapping") ||
			snippetLower.includes("@getmapping") ||
			snippetLower.includes("@postmapping") ||
			snippetLower.includes("@restcontroller") ||
			snippetLower.includes("@controller")
		) {
			score += 14;
			explain.push("spring route annotation");
		}
		if (
			snippetLower.includes("dobusiness(") ||
			snippetLower.includes("process(") ||
			snippetLower.includes("handle(") ||
			snippetLower.includes("execute(") ||
			snippetLower.includes("dispatch(")
		) {
			score += 10;
			explain.push("core-method naming hint");
		}
		if (snippetLower.includes("funcode") || snippetLower.includes("signreq")) {
			score += 10;
			explain.push("dispatch/request-type hint");
		}
	}

	if (intent === "core_method") {
		if (/(controller|router|route|handler|service|serviceimpl|manager|processor|executor|biz)/i.test(hit.file)) {
			score += 12;
			explain.push("core_method intent path boost");
		}
		if (
			snippetLower.includes("@requestmapping") ||
			snippetLower.includes("@getmapping") ||
			snippetLower.includes("@postmapping") ||
			snippetLower.includes("funcode") ||
			snippetLower.includes("dispatch(") ||
			snippetLower.includes("execute(") ||
			snippetLower.includes("dobusiness(")
		) {
			score += 16;
			explain.push("core_method intent chain boost");
		}
	}

	if (/(webapp|template|templates|contract|agreement|protocol|docs?|resources)/i.test(hit.file)) {
		score -= 8;
		explain.push("document/template/resources path penalty");
	}

	return {
		...hit,
		score,
		explain,
	};
}

function deriveLikelyPrimaryMethod(file: string, snippet: string): string | undefined {
	const classMatch = snippet.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
	const methodMatches = Array.from(
		snippet.matchAll(
			/\b(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?[A-Za-z0-9_<>[\], ?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g,
		),
	);
	const preferred = ["doBusiness", "handle", "process", "execute", "dispatch", "route", "sign"];
	const picked =
		methodMatches.find((match) => preferred.some((name) => match[1].toLowerCase().includes(name.toLowerCase()))) ??
		methodMatches[0];
	if (!picked) {
		return undefined;
	}

	const className =
		classMatch?.[1] ??
		file
			.split("/")
			.pop()
			?.replace(/\.[^.]+$/, "");
	if (!className) {
		return picked[1];
	}
	return `${className}#${picked[1]}(${picked[2].trim()})`;
}

function deriveCallChainHint(file: string, snippet: string): string | undefined {
	const fileLower = file.toLowerCase();
	const snippetLower = snippet.toLowerCase();

	if (
		/(controller|router|route|handler)/.test(fileLower) ||
		snippetLower.includes("@requestmapping") ||
		snippetLower.includes("@getmapping") ||
		snippetLower.includes("@postmapping")
	) {
		return "Controller/Route -> Service";
	}
	if (snippetLower.includes("funcode") || snippetLower.includes("enum")) {
		return "Controller/Route -> Enum/Dispatch -> Handler/Service";
	}
	if (/(service|serviceimpl|manager|processor|executor|biz)/.test(fileLower)) {
		return "Service -> downstream processor/gateway/DAO";
	}
	return undefined;
}

function deriveUpstreamRoutes(file: string, snippet: string): string[] {
	const results = new Set<string>();

	for (const match of snippet.matchAll(
		/@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping)\(([^)]*)\)/g,
	)) {
		const annotation = match[1];
		const args = match[2];
		const valueMatch = args.match(/["']([^"']+)["']/);
		if (valueMatch) {
			results.add(`${annotation}:${valueMatch[1]}`);
		} else {
			results.add(annotation);
		}
	}

	for (const match of snippet.matchAll(/\bfunCode\s*[=:]\s*["']?([A-Za-z0-9_:-]+)["']?/g)) {
		results.add(`funCode:${match[1]}`);
	}

	if (results.size === 0 && /(controller|router|route|handler)/i.test(file)) {
		results.add("route-like file path");
	}

	return Array.from(results).slice(0, 5);
}

function deriveDownstreamCalls(snippet: string): string[] {
	const results = new Set<string>();
	for (const match of snippet.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\(/g)) {
		const target = `${match[1]}.${match[2]}`;
		if (
			target.startsWith("this.") ||
			target.startsWith("log.") ||
			target.startsWith("logger.") ||
			target.startsWith("System.")
		) {
			continue;
		}
		results.add(target);
	}
	return Array.from(results).slice(0, 8);
}

function deriveWhyThisIsCore(hit: RankedProbeSearchHit): string[] {
	const reasons = [...hit.explain];
	const snippetLower = hit.snippet.toLowerCase();

	if (
		snippetLower.includes("@requestmapping") ||
		snippetLower.includes("@getmapping") ||
		snippetLower.includes("@postmapping")
	) {
		reasons.push("request entry annotation present");
	}
	if (snippetLower.includes("funcode")) {
		reasons.push("funCode-style dispatch present");
	}
	if (snippetLower.includes("signreq") || snippetLower.includes("sign")) {
		reasons.push("signing request vocabulary present");
	}

	return Array.from(new Set(reasons)).slice(0, 6);
}

function buildProbeSearchPayload(
	output: string,
	query: string,
	options: {
		path: string;
		expandedQuery?: string;
		reranker: string;
		rerankerPlan: string[];
		executionAttempts: ProbeSearchPayload["execution"]["attempts"];
		strictReranker: boolean;
		exact: boolean;
		anyTerm: boolean;
		allowTests: boolean;
		filesOnlyRequested: boolean;
		codeOnly: boolean;
		intent: "generic" | "core_method";
		synonymExpansion: boolean;
		moduleHint: string[];
		moduleScope: "prefer" | "strict";
		includeGlobs: string[];
		excludeGlobs: string[];
		preferEntrypoints: boolean;
		maxFiles: number;
		maxSnippetsPerFile: number;
		maxLinesPerSnippet: number;
	},
): ProbeSearchPayload | undefined {
	const parsed = parseProbeSearchHits(output);
	if (parsed.hits.length === 0) {
		return undefined;
	}

	const projectSynonyms = loadProjectProbeSynonyms(options.path);
	const synonymMap = mergeSynonyms(projectSynonyms);
	const queryTerms = expandQueryTerms(splitQueryTerms(query), options.synonymExpansion, synonymMap);
	const rankedHits = parsed.hits
		.filter((hit) => {
			if (options.includeGlobs.length > 0 && !matchesAnyGlob(hit.file, options.includeGlobs)) {
				return false;
			}
			if (matchesAnyGlob(hit.file, options.excludeGlobs)) {
				return false;
			}
			if (options.codeOnly && !isCodeFile(hit.file)) {
				return false;
			}
			if (
				options.moduleScope === "strict" &&
				options.moduleHint.length > 0 &&
				!pathHasAnyHint(hit.file, options.moduleHint)
			) {
				return false;
			}
			return true;
		})
		.map((hit) => rankProbeSearchHit(hit, queryTerms, options.preferEntrypoints, options.moduleHint, options.intent))
		.sort((a, b) => b.score - a.score);

	const fileToHits = new Map<string, RankedProbeSearchHit[]>();
	for (const hit of rankedHits) {
		const existing = fileToHits.get(hit.file) ?? [];
		existing.push(hit);
		fileToHits.set(hit.file, existing);
	}

	const topFiles = Array.from(fileToHits.entries())
		.sort((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0))
		.slice(0, options.maxFiles);

	const candidates: ProbeSearchCandidate[] = topFiles.map(([file, hits]) => {
		const bestHit = hits[0];
		const { start, end } = parseProbeLineRange(bestHit.lines);
		const matchedTerms = Array.from(
			new Set([...getMatchedTerms(file, queryTerms), ...getMatchedTerms(bestHit.snippet, queryTerms)]),
		);
		const confidence: ProbeSearchCandidate["confidence"] =
			bestHit.score >= 20 ? "high" : bestHit.score >= 10 ? "medium" : "low";
		const snippets: ProbeSearchCandidateSnippet[] = hits.slice(0, options.maxSnippetsPerFile).map((hit) => {
			const clipped = clipSnippet(hit.snippet, options.maxLinesPerSnippet);
			const range = parseProbeLineRange(hit.lines);
			return {
				lines: hit.lines,
				start_line: range.start,
				end_line: range.end,
				preview: clipped.text,
				clipped: clipped.clipped,
			};
		});

		return {
			file,
			best_span: `${file}:${start}${start === end ? "" : `-${end}`}`,
			extract_target: `${file}:${start}${start === end ? "" : `-${end}`}`,
			confidence,
			score: bestHit.score,
			matched_terms: matchedTerms,
			explain: bestHit.explain,
			likely_primary_method: deriveLikelyPrimaryMethod(file, bestHit.snippet),
			call_chain_hint: deriveCallChainHint(file, bestHit.snippet),
			why_this_is_core: deriveWhyThisIsCore(bestHit),
			upstream_routes: deriveUpstreamRoutes(file, bestHit.snippet),
			downstream_calls: deriveDownstreamCalls(bestHit.snippet),
			snippets,
		};
	});

	const finalAttempt =
		options.executionAttempts[options.executionAttempts.length - 1] ??
		createExecutionAttempt(options.reranker, parsed.actualRankingLine);
	const primaryCandidate = candidates[0];

	return {
		query,
		path: options.path,
		expanded_query: options.expandedQuery,
		execution: {
			strict_reranker: options.strictReranker,
			retry_strategy: options.rerankerPlan,
			requested_reranker: options.reranker,
			applied_reranker: finalAttempt.applied_reranker,
			fallback_reason: finalAttempt.fallback_reason,
			quality_impact: finalAttempt.quality_impact,
			probe_banner: finalAttempt.probe_banner,
			attempts: options.executionAttempts,
		},
		filters: {
			exact: options.exact,
			any_term: options.anyTerm,
			allow_tests: options.allowTests,
			files_only_requested: options.filesOnlyRequested,
			code_only: options.codeOnly,
			intent: options.intent,
			synonym_expansion: options.synonymExpansion,
			module_hint: options.moduleHint,
			module_scope: options.moduleScope,
			include_globs: options.includeGlobs,
			exclude_globs: options.excludeGlobs,
		},
		summary: {
			raw_hits: parsed.foundResults ?? parsed.hits.length,
			filtered_hits: rankedHits.length,
			unique_files: fileToHits.size,
			returned_files: candidates.length,
		},
		candidates,
		suggestions: primaryCandidate
			? [
					`Next best action: probe_extract ${primaryCandidate.extract_target}`,
					(primaryCandidate.upstream_routes?.length ?? 0) > 0
						? "If you need entrypoint proof, continue by extracting the route/funCode carrier or enum next."
						: "If you need stronger routing evidence, continue by extracting the nearest controller/handler candidate.",
					(primaryCandidate.downstream_calls?.length ?? 0) > 0
						? "If you need execution proof, continue by extracting the first downstream service/dao call target."
						: "If you need execution proof, continue by extracting the target service implementation next.",
					options.filesOnlyRequested
						? "If file ranking is still noisy, tighten include_globs/exclude_globs or use exact=true."
						: "If results are noisy, retry with files_only=true or tighter include_globs/exclude_globs.",
				]
			: [
					"No strong candidates. Relax the query, remove filters, or try probe_query with a loose structural pattern.",
				],
	};
}

function renderSmartProbeSearchResult(payload: ProbeSearchPayload, maxLinesPerSnippet: number): string {
	const lines: string[] = [];
	lines.push("Probe search summary");
	lines.push(`- Query: ${payload.query}`);
	if (payload.expanded_query) {
		lines.push(`- Expanded query: ${payload.expanded_query}`);
	}
	lines.push(`- Requested reranker: ${payload.execution.requested_reranker}`);
	lines.push(`- Applied reranker: ${payload.execution.applied_reranker}`);
	lines.push(`- Quality impact: ${payload.execution.quality_impact}`);
	lines.push(`- Retry strategy: ${payload.execution.retry_strategy.join(" -> ")}`);
	if (payload.execution.fallback_reason) {
		lines.push(`- Fallback: ${payload.execution.fallback_reason}`);
	}
	if (payload.execution.probe_banner) {
		lines.push(`- Probe banner: ${payload.execution.probe_banner}`);
	}
	lines.push(`- Raw hits: ${payload.summary.raw_hits}`);
	lines.push(`- Filtered hits: ${payload.summary.filtered_hits}`);
	lines.push(`- Unique files: ${payload.summary.unique_files}`);
	lines.push("");
	lines.push("Top files");

	for (const [index, candidate] of payload.candidates.entries()) {
		lines.push(
			`${index + 1}. ${candidate.file} [${candidate.confidence}] best_span=${candidate.best_span} score=${candidate.score}`,
		);
		lines.push(`   explain: ${candidate.explain.join(", ") || "ranked"}`);
		if (candidate.likely_primary_method) {
			lines.push(`   likely_primary_method: ${candidate.likely_primary_method}`);
		}
		if (candidate.call_chain_hint) {
			lines.push(`   call_chain_hint: ${candidate.call_chain_hint}`);
		}
		if (candidate.why_this_is_core?.length) {
			lines.push(`   why_this_is_core: ${candidate.why_this_is_core.join(", ")}`);
		}
		if (candidate.upstream_routes?.length) {
			lines.push(`   upstream_routes: ${candidate.upstream_routes.join(", ")}`);
		}
		if (candidate.downstream_calls?.length) {
			lines.push(`   downstream_calls: ${candidate.downstream_calls.join(", ")}`);
		}
		if (candidate.matched_terms.length > 0) {
			lines.push(`   matched_terms: ${candidate.matched_terms.join(", ")}`);
		}
	}

	if (!payload.filters.files_only_requested) {
		lines.push("");
		lines.push("Expanded snippets");
		for (const candidate of payload.candidates) {
			for (const snippet of candidate.snippets) {
				lines.push(`- ${candidate.file}:${snippet.lines}`);
				lines.push("```");
				lines.push(snippet.preview);
				lines.push("```");
				if (snippet.clipped) {
					lines.push(`  note: clipped to ${maxLinesPerSnippet} lines`);
				}
				lines.push("");
			}
		}
	}

	lines.push("Suggestions");
	for (const suggestion of payload.suggestions) {
		lines.push(`- ${suggestion}`);
	}

	return lines.join("\n").trim();
}

function appendIncludeGlobsToQuery(query: string, includeGlobs: string[]): string {
	if (includeGlobs.length === 0) {
		return query;
	}
	const clauses = includeGlobs.map((glob) => `file:${glob}`);
	if (clauses.length === 1) {
		return `${query} AND ${clauses[0]}`;
	}
	return `${query} AND (${clauses.join(" OR ")})`;
}

function buildExpandedQuery(
	query: string,
	synonymExpansion: boolean,
	includeGlobs: string[],
	synonymMap: ProbeSynonymMap,
): string {
	const withInclude = appendIncludeGlobsToQuery(query, includeGlobs);
	if (!synonymExpansion) {
		return withInclude;
	}

	let expanded = withInclude;
	for (const [term, synonyms] of Object.entries(synonymMap)) {
		if (query.includes(term)) {
			const clause = `(${[term, ...synonyms].join(" OR ")})`;
			expanded += ` OR ${clause}`;
		}
	}
	return expanded;
}

export function registerProbeSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "probe_search",
		label: "Probe Search",
		description:
			"Search the codebase with `probe search` to find the most relevant code blocks by intent or concept. Prefer short keyword queries first, not full business questions. Output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Semantic code search with Probe for concept-level discovery across the repo.",
		promptGuidelines: [
			"Start with 2-6 focused keywords, names, or phrases. Do not start with a long natural-language question unless you have no better terms.",
			"Use exact=true for specific identifiers, quoted phrases, exact Chinese labels, method names, or constants.",
			"Use files_only=true for a first narrowing pass, then use probe_extract on the best file or path:line hit.",
			"Prefer output_mode=agent_json unless you explicitly need prose output.",
			"Keep code_only=true by default when you are looking for implementation entrypoints or core methods.",
			"Use intent=core_method for controller/router/dispatch/service entrypoint problems instead of generic semantic search.",
		],
		parameters: ProbeSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeProbeSearch(pi, params, ctx.cwd, signal);
		},
	});
}

export async function executeProbeSearch(
	pi: ExtensionAPI,
	options: ProbeSearchExecuteOptions,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{
	content: [{ type: "text"; text: string }];
	details: ProbeToolDetails;
	payload?: ProbeSearchPayload;
}> {
	const projectSynonyms = loadProjectProbeSynonyms(cwd);
	const synonymMap = mergeSynonyms(projectSynonyms);
	const includeGlobs = options.include_globs ?? [];
	const excludeGlobs = options.exclude_globs ?? [];
	const outputMode = options.output_mode ?? "agent_json";
	const smart = options.smart !== false && outputMode !== "raw_text";
	const strictReranker = options.strict_reranker === true;
	const autoRetryReranker = options.auto_retry_reranker !== false;
	const moduleHint = options.module_hint ?? [];
	const moduleScope = options.module_scope ?? "prefer";
	const intent = options.intent ?? "generic";
	const synonymExpansion = options.synonym_expansion === true;
	const codeOnly = options.code_only !== false;
	const path = normalizeOptionalString(options.path);
	const reranker = options.reranker ?? "hybrid";
	const effectiveQuery = buildExpandedQuery(options.query, synonymExpansion, includeGlobs, synonymMap);
	const rerankerPlan = buildRerankerPlan(reranker, autoRetryReranker);
	const executionAttempts: ProbeSearchPayload["execution"]["attempts"] = [];

	let result: Awaited<ReturnType<typeof runProbe>> | undefined;
	for (const requestedAttemptReranker of rerankerPlan) {
		const args: string[] = [effectiveQuery];
		if (path) {
			args.push(path);
		} else {
			args.push(".");
		}
		args.push("--reranker", requestedAttemptReranker);
		if (options.exact === true) {
			args.push("--exact");
		}
		if (options.any_term === true) {
			args.push("--any-term");
		}
		if (options.files_only === true && !smart) {
			args.push("--files-only");
		}
		if (options.allow_tests === true) {
			args.push("--allow-tests");
		}
		for (const ignorePattern of excludeGlobs) {
			args.push("--ignore", ignorePattern);
		}
		if (options.max_results !== undefined) {
			args.push("--max-results", String(options.max_results));
		}
		if (options.max_bytes !== undefined) {
			args.push("--max-bytes", String(options.max_bytes));
		}
		if (options.max_tokens !== undefined) {
			args.push("--max-tokens", String(options.max_tokens));
		}

		result = await runProbe(pi, "search", args, cwd, signal);
		const contentText = result.content[0]?.text ?? "";
		const parsed = parseProbeSearchHits(contentText);
		const executionAttempt = createExecutionAttempt(requestedAttemptReranker, parsed.actualRankingLine);
		executionAttempts.push({
			requested_reranker: executionAttempt.requested_reranker,
			applied_reranker: executionAttempt.applied_reranker,
			probe_banner: executionAttempt.probe_banner,
			fallback_reason: executionAttempt.fallback_reason,
			quality_impact: executionAttempt.quality_impact,
		});

		if (executionAttempt.applied_reranker === requestedAttemptReranker) {
			break;
		}
	}

	if (!result) {
		throw new Error("probe search failed before producing any result");
	}

	const contentText = result.content[0]?.text ?? "";
	if (!smart) {
		return result;
	}

	const payload = buildProbeSearchPayload(contentText, options.query, {
		path: path ?? cwd,
		expandedQuery: effectiveQuery !== options.query ? effectiveQuery : undefined,
		reranker,
		rerankerPlan,
		executionAttempts,
		strictReranker,
		exact: options.exact === true,
		anyTerm: options.any_term === true,
		allowTests: options.allow_tests === true,
		filesOnlyRequested: options.files_only === true,
		codeOnly,
		intent,
		synonymExpansion,
		moduleHint,
		moduleScope,
		includeGlobs,
		excludeGlobs,
		preferEntrypoints: options.prefer_entrypoints !== false,
		maxFiles: options.max_files ?? 6,
		maxSnippetsPerFile: options.max_snippets_per_file ?? 1,
		maxLinesPerSnippet: options.max_lines_per_snippet ?? 24,
	});
	if (!payload) {
		return result;
	}
	if (
		payload.execution.strict_reranker &&
		payload.execution.applied_reranker !== payload.execution.requested_reranker
	) {
		throw new Error(
			`probe search strict_reranker failed: requested ${payload.execution.requested_reranker}, applied ${payload.execution.applied_reranker}. ${payload.execution.fallback_reason ?? ""}`.trim(),
		);
	}

	const rendered =
		outputMode === "smart_text"
			? renderSmartProbeSearchResult(payload, options.max_lines_per_snippet ?? 24)
			: JSON.stringify(payload, null, 2);
	const smartTruncation = truncateProbeOutput(rendered);

	return {
		content: [{ type: "text", text: smartTruncation.text }],
		details: {
			...result.details,
			truncation: smartTruncation.truncation ?? result.details.truncation,
		},
		payload,
	};
}
