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

const ProbeSearchParams = Type.Object({
	query: Type.String({ description: "Natural-language or keyword query to pass to `probe search`." }),
	path: Type.Optional(
		Type.String({ description: "Directory or file path to search. Defaults to the current project." }),
	),
	max_results: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of results to return." })),
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
			"Search the codebase with `probe search` to find the most relevant code blocks by intent or concept. Output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Semantic code search with Probe for concept-level discovery across the repo.",
		promptGuidelines: [
			"Use this before broad read/grep sweeps when you need the most relevant code blocks for a behavior, feature, or concept.",
		],
		parameters: ProbeSearchParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const args: string[] = [params.query];
			const path = normalizeOptionalString(params.path);

			if (path) {
				args.push(path);
			} else {
				args.push(".");
			}
			if (params.max_results !== undefined) {
				args.push("--max-results", String(params.max_results));
			}
			if (params.max_tokens !== undefined) {
				args.push("--max-tokens", String(params.max_tokens));
			}

			return runProbe(pi, "search", args, ctx.cwd, signal);
		},
	});

	pi.registerTool({
		name: "probe_query",
		label: "Probe Query",
		description:
			"Run `probe query` for structural code matching when you know the shape of code you want to find. Output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Structural code search with Probe when you know the AST or syntax pattern to match.",
		promptGuidelines: [
			"Use this when you know the code shape you want, such as function signatures, imports, classes, or specific syntax patterns.",
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
			"Run `probe extract` to extract the closest useful code block for a specific file path or `path:line` location. Output is truncated to 2000 lines or 50KB.",
		promptSnippet: "Precise AST-aware extraction with Probe for a specific file or path:line location.",
		promptGuidelines: [
			"Use this after search/query identifies a likely location and you want the surrounding function, class, or code block.",
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
- Use probe_search for semantic code discovery when you need relevant code by intent.
- Use probe_query for structural matching when you know the syntax or AST shape to find.
- Use probe_extract for a precise file or path:line extraction after you identify a target.
- These tools call the local Probe CLI directly. Do not assume MCP is involved.
`,
		};
	});
}
