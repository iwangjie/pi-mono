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
- Default to probe_core_method when the task is to find the core method, entrypoint, handler, dispatch path, or main execution chain.
- If you know the bounded area, pass module_hint. This is the main way to improve stability; do not start by tuning many Probe parameters.
- Use probe_search as the expert fallback for manual exploration. Prefer short 2-6 term queries or exact identifiers, not long business questions.
- If probe_search returns a promising file or line range, call probe_extract next with file, path:line, path:start-end, or path#symbol.
- Use probe_query only for structural matching after search or extract already narrowed the area. Start loose with placeholders like $NAME, $$$ARGS, $$$BODY.
- Read primary_failure_reason and best_next_change before retrying. Change one thing at a time.
- These tools call the local Probe CLI directly. Do not assume MCP is involved.
`,
		};
	});
}
