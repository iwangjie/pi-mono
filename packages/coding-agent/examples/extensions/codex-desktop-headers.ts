import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CODEX_DESKTOP_ORIGINATOR = "Codex Desktop";
const CODEX_DESKTOP_USER_AGENT = "Codex Desktop/0.114.0 (Mac OS 26.3.1; arm64) Apple_Terminal/466";

export default function (pi: ExtensionAPI) {
	// Override request headers for the built-in `openai-codex` models.
	//
	// Requires pi-ai >= the version that respects user-provided originator/user-agent
	// in the codex provider.
	pi.registerProvider("openai-codex", {
		headers: {
			originator: CODEX_DESKTOP_ORIGINATOR,
			"User-Agent": CODEX_DESKTOP_USER_AGENT,
		},
	});
}
