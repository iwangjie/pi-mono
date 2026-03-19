import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@mariozechner/pi-coding-agent";

export const PROBE_TIMEOUT_MS = 120_000;

export type ProbeSubcommand = "search" | "query" | "extract";

export interface ProbeToolDetails {
	subcommand: ProbeSubcommand;
	args: string[];
	cwd: string;
	exitCode: number;
	truncation?: TruncationResult;
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function truncateProbeOutput(output: string): { text: string; truncation?: TruncationResult } {
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

export async function runProbe(
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
