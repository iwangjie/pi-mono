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
import { registerProbeCoreMethod } from "./core-method.js";
import { registerProbeExtract, registerProbeQuery } from "./query-extract.js";
import { registerProbeSearch } from "./search.js";

export default function probeExtension(pi: ExtensionAPI) {
	registerProbeSearch(pi);
	registerProbeQuery(pi);
	registerProbeExtract(pi);
	registerProbeCoreMethod(pi);

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
- For "核心方法是哪个" 这类问题， prefer using probe_core_method instead of manually tuning probe_search.
- Use intent=core_method when the question is "核心方法是哪个" or when you need a Controller/Route -> Service -> DAO style chain.
- Use module_hint when you already suspect a module or bounded area, for example trans-business.
- Use module_scope=strict when the module boundary is known and you want Probe to stay inside it.
- Leave auto_retry_reranker enabled so Probe can retry hybrid -> hybrid2 -> bm25 when the first reranker falls back.
- Use strict_reranker=true only when you must guarantee the requested reranker was actually applied.
- If probe_search finds a promising file or line range, call probe_extract next with file, path:line, path:start-end, or path#symbol.
- Use probe_query only when you need structural matching. Start loose with placeholders like $NAME, $$$ARGS, $$$BODY.
- For probe_query, do not hardcode full Java signatures on the first try. Avoid fixing return type, modifiers, annotations, and throws clauses unless required.
- These tools call the local Probe CLI directly. Do not assume MCP is involved.
`,
		};
	});
}
