/**
 * Probe CLI Extension
 *
 * Registers three local CLI-backed tools:
 * - probe_search  -> `probe search`
 * - probe_query   -> `probe query`
 * - probe_extract -> `probe extract`
 *
 * Usage:
 * 1. Install Probe CLI: npm install -g @buger/probe@latest
 * 2. Load this extension with `--extension` or copy it into an extensions directory
 *
 * This example intentionally uses the local Probe CLI directly. It does not use MCP.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const PROBE_TIMEOUT_MS = 120_000;

type ProbeSubcommand = "search" | "query" | "extract";

interface ProbeToolDetails {
	subcommand: ProbeSubcommand;
	args: string[];
	cwd: string;
	exitCode: number;
	truncation?: TruncationResult;
}

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
	snippets: ProbeSearchCandidateSnippet[];
}

interface ProbeSearchPayload {
	query: string;
	path: string;
	expanded_query?: string;
	execution: {
		strict_reranker: boolean;
		requested_reranker: string;
		applied_reranker: string;
		fallback_reason?: string;
		quality_impact: "none" | "low" | "medium" | "high";
		probe_banner?: string;
	};
	filters: {
		exact: boolean;
		any_term: boolean;
		allow_tests: boolean;
		files_only_requested: boolean;
		code_only: boolean;
		synonym_expansion: boolean;
		module_hint: string[];
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

const ProbeSearchParams = Type.Object({
	query: Type.String({ description: "Natural-language or keyword query to pass to `probe search`." }),
	path: Type.Optional(
		Type.String({ description: "Directory or file path to search. Defaults to the current project." }),
	),
	reranker: Type.Optional(ProbeReranker),
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

const ProbeQueryParams = Type.Object({
	pattern: Type.String({
		description: "Structural query pattern for `probe query`, for example `function $NAME($$$PARAMS) $$$BODY`.",
	}),
	path: Type.Optional(
		Type.String({ description: "Directory or file path to search. Defaults to the current project." }),
	),
	language: Type.Optional(Type.String({ description: "Language hint passed to `--language` when needed." })),
	max_results: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of matches to return." })),
	strategy: Type.Optional(
		StringEnum(["loose", "strict"] as const, {
			description:
				"`loose` means start with a minimal pattern and placeholders. `strict` means the pattern is already precise.",
		}),
	),
});

const ProbeExtractParams = Type.Object({
	target: Type.String({
		description: "Target for `probe extract`, usually a file path or `path:line` location.",
	}),
});

function normalizeOptionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function splitQueryTerms(query: string): string[] {
	return query
		.split(/[\s,，。;；:：/|()[\]{}"'`<>!?！？]+/)
		.map((term) => term.trim())
		.filter((term) => term.length >= 2)
		.slice(0, 12);
}

const QUERY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
	自由职业者: ["soho", "灵工"],
	soho: ["自由职业者", "灵工"],
	灵工: ["自由职业者", "soho"],
	签约: ["签署", "sign", "contract", "signreq", "dobusiness"],
	签署: ["签约", "sign", "contract"],
	服务商: ["merchant", "provider"],
	平台: ["platform"],
};

function expandQueryTerms(terms: string[], enabled: boolean): string[] {
	if (!enabled) {
		return terms;
	}

	const expanded = new Set<string>(terms);
	for (const term of terms) {
		for (const [source, synonyms] of Object.entries(QUERY_SYNONYMS)) {
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

function determineAppliedReranker(
	requestedReranker: string,
	actualRankingLine: string | undefined,
	strictReranker: boolean,
): ProbeSearchPayload["execution"] {
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
		strict_reranker: strictReranker,
		requested_reranker: requestedReranker,
		applied_reranker: appliedReranker,
		fallback_reason: fallbackReason,
		quality_impact: qualityImpact,
		probe_banner: actualRankingLine,
	};
}

function rankProbeSearchHit(
	hit: ProbeSearchHit,
	queryTerms: string[],
	preferEntrypoints: boolean,
	moduleHints: string[],
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
		strictReranker: boolean;
		exact: boolean;
		anyTerm: boolean;
		allowTests: boolean;
		filesOnlyRequested: boolean;
		codeOnly: boolean;
		synonymExpansion: boolean;
		moduleHint: string[];
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

	const queryTerms = expandQueryTerms(splitQueryTerms(query), options.synonymExpansion);
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
			return true;
		})
		.map((hit) => rankProbeSearchHit(hit, queryTerms, options.preferEntrypoints, options.moduleHint))
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
			snippets,
		};
	});

	return {
		query,
		path: options.path,
		expanded_query: options.expandedQuery,
		execution: determineAppliedReranker(options.reranker, parsed.actualRankingLine, options.strictReranker),
		filters: {
			exact: options.exact,
			any_term: options.anyTerm,
			allow_tests: options.allowTests,
			files_only_requested: options.filesOnlyRequested,
			code_only: options.codeOnly,
			synonym_expansion: options.synonymExpansion,
			module_hint: options.moduleHint,
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
		suggestions: candidates.length
			? [
					`Next best action: probe_extract ${candidates[0].extract_target}`,
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

function buildExpandedQuery(query: string, synonymExpansion: boolean, includeGlobs: string[]): string {
	const withInclude = appendIncludeGlobsToQuery(query, includeGlobs);
	if (!synonymExpansion) {
		return withInclude;
	}

	let expanded = withInclude;
	for (const [term, synonyms] of Object.entries(QUERY_SYNONYMS)) {
		if (query.includes(term)) {
			const clause = `(${[term, ...synonyms].join(" OR ")})`;
			expanded += ` OR ${clause}`;
		}
	}
	return expanded;
}

function truncateProbeOutput(output: string): { text: string; truncation?: TruncationResult } {
	if (!output.trim()) {
		return { text: "Probe returned no output." };
	}

	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let text = truncation.content;
	if (truncation.truncated) {
		text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
			truncation.outputBytes,
		)} of ${formatSize(truncation.totalBytes)}).]`;
	}

	return {
		text,
		truncation: truncation.truncated ? truncation : undefined,
	};
}

function formatCombinedOutput(stdout: string, stderr: string): string {
	const trimmedStdout = stdout.trim();
	const trimmedStderr = stderr.trim();

	if (trimmedStdout && trimmedStderr) {
		return `${trimmedStdout}\n\n[stderr]\n${trimmedStderr}`;
	}
	if (trimmedStdout) {
		return trimmedStdout;
	}
	if (trimmedStderr) {
		return trimmedStderr;
	}
	return "";
}

function formatProbeError(subcommand: ProbeSubcommand, stderr: string, stdout: string): string {
	const combined = formatCombinedOutput(stdout, stderr);
	if (combined) {
		return `probe ${subcommand} failed:\n${combined}`;
	}
	return `probe ${subcommand} failed. Make sure the \`probe\` CLI is installed and available on PATH.`;
}

async function runProbe(
	pi: ExtensionAPI,
	subcommand: ProbeSubcommand,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ content: [{ type: "text"; text: string }]; details: ProbeToolDetails }> {
	const result = await pi.exec("probe", [subcommand, ...args], {
		cwd,
		signal,
		timeout: PROBE_TIMEOUT_MS,
	});

	if (result.killed) {
		throw new Error(`probe ${subcommand} was aborted or timed out after ${PROBE_TIMEOUT_MS}ms.`);
	}

	if (result.code !== 0) {
		throw new Error(formatProbeError(subcommand, result.stderr, result.stdout));
	}

	const output = formatCombinedOutput(result.stdout, result.stderr);
	const truncated = truncateProbeOutput(output);

	return {
		content: [{ type: "text", text: truncated.text }],
		details: {
			subcommand,
			args,
			cwd,
			exitCode: result.code,
			truncation: truncated.truncation,
		},
	};
}

export default function probeExtension(pi: ExtensionAPI) {
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
		],
		parameters: ProbeSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const includeGlobs = params.include_globs ?? [];
			const excludeGlobs = params.exclude_globs ?? [];
			const outputMode = params.output_mode ?? "agent_json";
			const smart = params.smart !== false && outputMode !== "raw_text";
			const strictReranker = params.strict_reranker === true;
			const moduleHint = params.module_hint ?? [];
			const synonymExpansion = params.synonym_expansion === true;
			const codeOnly = params.code_only !== false;
			const effectiveQuery = buildExpandedQuery(params.query, synonymExpansion, includeGlobs);
			const args: string[] = [effectiveQuery];
			const path = normalizeOptionalString(params.path);
			const reranker = params.reranker ?? "hybrid";

			if (path) {
				args.push(path);
			} else {
				args.push(".");
			}
			args.push("--reranker", reranker);
			if (params.exact === true) {
				args.push("--exact");
			}
			if (params.any_term === true) {
				args.push("--any-term");
			}
			if (params.files_only === true && !smart) {
				args.push("--files-only");
			}
			if (params.allow_tests === true) {
				args.push("--allow-tests");
			}
			for (const ignorePattern of excludeGlobs) {
				args.push("--ignore", ignorePattern);
			}
			if (params.max_results !== undefined) {
				args.push("--max-results", String(params.max_results));
			}
			if (params.max_bytes !== undefined) {
				args.push("--max-bytes", String(params.max_bytes));
			}
			if (params.max_tokens !== undefined) {
				args.push("--max-tokens", String(params.max_tokens));
			}

			const result = await runProbe(pi, "search", args, ctx.cwd, signal);
			const contentText = result.content[0]?.text ?? "";
			if (!smart) {
				return result;
			}

			const payload = buildProbeSearchPayload(contentText, params.query, {
				path: path ?? ctx.cwd,
				expandedQuery: effectiveQuery !== params.query ? effectiveQuery : undefined,
				reranker,
				strictReranker,
				exact: params.exact === true,
				anyTerm: params.any_term === true,
				allowTests: params.allow_tests === true,
				filesOnlyRequested: params.files_only === true,
				codeOnly,
				synonymExpansion,
				moduleHint,
				includeGlobs,
				excludeGlobs,
				preferEntrypoints: params.prefer_entrypoints !== false,
				maxFiles: params.max_files ?? 6,
				maxSnippetsPerFile: params.max_snippets_per_file ?? 1,
				maxLinesPerSnippet: params.max_lines_per_snippet ?? 24,
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
					? renderSmartProbeSearchResult(payload, params.max_lines_per_snippet ?? 24)
					: JSON.stringify(payload, null, 2);
			const smartTruncation = truncateProbeOutput(rendered);

			return {
				content: [{ type: "text", text: smartTruncation.text }],
				details: {
					...result.details,
					truncation: smartTruncation.truncation ?? result.details.truncation,
				},
			};
		},
	});

	pi.registerTool({
		name: "probe_query",
		label: "Probe Query",
		description:
			"Run `probe query` for structural code matching when you know the code shape you want. Start with a loose pattern unless you already know the exact syntax. Output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Structural code search with Probe when you know the AST or syntax pattern to match.",
		promptGuidelines: [
			"Use this after search or extract narrowed the area, or when you already know the syntax shape to match.",
			"Default to loose patterns first: prefer placeholders like $NAME, $$$ARGS, $$$BODY and avoid hardcoding modifiers, return types, throws clauses, and annotations unless necessary.",
			"If a strict query returns no results, relax it instead of retrying the same full signature shape.",
		],
		parameters: ProbeQueryParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args: string[] = [params.pattern];
			const path = normalizeOptionalString(params.path);
			const language = normalizeOptionalString(params.language);

			if (path) {
				args.push(path);
			} else {
				args.push(".");
			}
			if (language) {
				args.push("--language", language);
			}
			if (params.max_results !== undefined) {
				args.push("--max-results", String(params.max_results));
			}

			return runProbe(pi, "query", args, ctx.cwd, signal);
		},
	});

	pi.registerTool({
		name: "probe_extract",
		label: "Probe Extract",
		description:
			"Run `probe extract` to extract the closest useful code block for a specific file path, `path:line`, `path:start-end`, or `path#symbol` target. Output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Precise AST-aware extraction with Probe for a specific file or path:line location.",
		promptGuidelines: [
			"Use this immediately after search/query identifies a likely file or hit. Prefer extract over broad re-search when you already have a concrete location.",
		],
		parameters: ProbeExtractParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return runProbe(pi, "extract", [params.target], ctx.cwd, signal);
		},
	});

	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt:
				event.systemPrompt +
				`

Probe CLI tools are available:
- Use probe_search first for discovery. Prefer short targeted keywords, exact identifiers, Chinese labels, or 2-6 term queries instead of long business questions.
- For probe_search, prefer reranker=hybrid unless you have a reason not to. Use exact=true for specific method names, variables, constants, or exact phrases.
- For probe_search, prefer output_mode=agent_json so you can read stable fields like execution, candidates, best_span, confidence, and extract_target.
- For probe_search, keep code_only=true unless you intentionally want docs, config, jsp, sql, or templates.
- Use module_hint when you already suspect a module or bounded area, for example trans-business.
- Use strict_reranker=true only when you must guarantee the requested reranker was actually applied.
- If probe_search finds a promising file or line range, call probe_extract next with file, path:line, path:start-end, or path#symbol.
- Use probe_query only when you need structural matching. Start loose with placeholders like $NAME, $$$ARGS, $$$BODY.
- For probe_query, do not hardcode full Java signatures on the first try. Avoid fixing return type, modifiers, annotations, and throws clauses unless required.
- These tools call the local Probe CLI directly. Do not assume MCP is involved.
`,
		};
	});
}
