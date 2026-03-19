import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { normalizeOptionalString, runProbe } from "./common.js";

export const ProbeQueryParams = Type.Object({
	pattern: Type.String({
		description: "Structural query pattern for `probe query`, for example `function $NAME($$$PARAMS) $$$BODY`.",
	}),
	path: Type.Optional(
		Type.String({ description: "Directory or file path to search. Defaults to the current project." }),
	),
	language: Type.Optional(Type.String({ description: "Language hint passed to `--language` when needed." })),
	max_results: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of matches to return." })),
	strategy: Type.Optional(
		Type.Union([Type.Literal("loose"), Type.Literal("strict")], {
			description:
				"`loose` means start with a minimal pattern and placeholders. `strict` means the pattern is already precise.",
		}),
	),
});

export const ProbeExtractParams = Type.Object({
	target: Type.String({
		description: "Target for `probe extract`, usually a file path or `path:line` location.",
	}),
});

export function registerProbeQuery(pi: ExtensionAPI) {
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
}

export function registerProbeExtract(pi: ExtensionAPI) {
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
}
