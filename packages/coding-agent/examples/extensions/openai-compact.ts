/**
 * OpenAI Compact Extension
 *
 * Replaces pi's human-summary-only compaction with OpenAI Responses
 * `/responses/compact`, while still fitting into pi's existing session model.
 *
 * How it works:
 * 1. `session_before_compact` sends the current Responses context window to
 *    `/responses/compact`
 * 2. The returned compacted window is stored in the compaction entry `details`
 * 3. `before_provider_request` swaps pi's text compaction summary back out for
 *    the stored compacted window before the next OpenAI Responses request
 *
 * Supported configuration:
 * - `PI_OPENAI_COMPACT_URL`
 *   Full endpoint or base URL. Examples:
 *   - `https://api.openai.com/v1`
 *   - `https://api.openai.com/v1/responses/compact`
 *   - `http://127.0.0.1:8317/`
 * - `PI_OPENAI_COMPACT_API_KEY`
 *   Optional override for the compact call. If unset, uses the current model's
 *   API key. If both are missing, the request is sent without Authorization.
 *
 * Usage:
 *   PI_OPENAI_COMPACT_URL=http://127.0.0.1:8317/ \
 *   pi --extension examples/extensions/openai-compact.ts
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@mariozechner/pi-ai";
import type { CompactionEntry, ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import type {
	CompactedResponse,
	ResponseCompactParams,
	ResponseFunctionCallOutputItemList,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "openai/resources/responses/responses.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
type CompactCapableApi = "openai-responses" | "openai-codex-responses";
type CompactCapableModel = Model<CompactCapableApi>;

interface StoredOpenAICompactWindow {
	type: "openai-compact-window";
	version: 1;
	endpoint: string;
	output: ResponseInput;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
}

interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStoredOpenAICompactWindow(details: unknown): details is StoredOpenAICompactWindow {
	if (!isRecord(details)) return false;
	return (
		details.type === "openai-compact-window" &&
		details.version === 1 &&
		typeof details.endpoint === "string" &&
		Array.isArray(details.output)
	);
}

function resolveCompactUrl(rawValue: string | undefined, fallbackBaseUrl: string): string {
	const value = rawValue?.trim() || fallbackBaseUrl.trim();
	if (!value) {
		return "https://api.openai.com/v1/responses/compact";
	}
	if (value.endsWith("/responses/compact")) {
		return value;
	}

	const url = new URL(value);
	const pathname = url.pathname.replace(/\/+$/, "");

	if (pathname === "") {
		url.pathname = "/v1/responses/compact";
		return url.toString();
	}

	if (pathname.endsWith("/v1")) {
		url.pathname = `${pathname}/responses/compact`;
		return url.toString();
	}

	url.pathname = `${pathname}/responses/compact`;
	return url.toString();
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: "commentary" | "final_answer" } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			return undefined;
		}
	}
	return { id: signature };
}

function createCompactionSummaryMessage(entry: CompactionEntry): AgentMessage {
	return {
		role: "compactionSummary",
		summary: entry.summary,
		tokensBefore: entry.tokensBefore,
		timestamp: new Date(entry.timestamp).getTime(),
	};
}

function createBranchSummaryMessage(entry: Extract<SessionEntry, { type: "branch_summary" }>): AgentMessage {
	return {
		role: "branchSummary",
		summary: entry.summary,
		fromId: entry.fromId,
		timestamp: new Date(entry.timestamp).getTime(),
	};
}

function createCustomMessage(entry: Extract<SessionEntry, { type: "custom_message" }>): AgentMessage {
	return {
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details,
		timestamp: new Date(entry.timestamp).getTime(),
	};
}

function appendSessionEntryMessages(target: AgentMessage[], entry: SessionEntry): void {
	if (entry.type === "message") {
		target.push(entry.message);
		return;
	}
	if (entry.type === "custom_message") {
		target.push(createCustomMessage(entry));
		return;
	}
	if (entry.type === "branch_summary" && entry.summary) {
		target.push(createBranchSummaryMessage(entry));
	}
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) {
			if (!deepEqual(left[i], right[i])) return false;
		}
		return true;
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		if (leftKeys.length !== rightKeys.length) return false;
		for (const key of leftKeys) {
			if (!(key in right)) return false;
			if (!deepEqual(left[key], right[key])) return false;
		}
		return true;
	}
	return false;
}

function startsWithItems(items: ResponseInput, prefix: ResponseInput): boolean {
	if (prefix.length > items.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (!deepEqual(items[i], prefix[i])) return false;
	}
	return true;
}

function normalizeToolCallId(model: CompactCapableModel, id: string): string {
	if (!OPENAI_TOOL_CALL_PROVIDERS.has(model.provider)) return id;
	if (!id.includes("|")) return id;
	const [callId, itemId] = id.split("|");
	const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
	let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!sanitizedItemId.startsWith("fc")) {
		sanitizedItemId = `fc_${sanitizedItemId}`;
	}
	const normalizedCallId = sanitizedCallId.slice(0, 64).replace(/_+$/, "");
	const normalizedItemId = sanitizedItemId.slice(0, 64).replace(/_+$/, "");
	return `${normalizedCallId}|${normalizedItemId}`;
}

function convertMessagesToResponsesInput(model: CompactCapableModel, messages: AgentMessage[]): ResponseInput {
	const llmMessages = convertToLlm(messages);
	const input: ResponseInput = [];
	let messageIndex = 0;

	for (const message of llmMessages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				input.push({
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: message.content }],
				});
				messageIndex++;
				continue;
			}

			const content: ResponseInputContent[] = message.content.map((item): ResponseInputContent => {
				if (item.type === "text") {
					return { type: "input_text", text: item.text } satisfies ResponseInputText;
				}
				return {
					type: "input_image",
					detail: "auto",
					image_url: `data:${item.mimeType};base64,${item.data}`,
				} satisfies ResponseInputImage;
			});

			const filteredContent = !model.input.includes("image")
				? content.filter((item) => item.type !== "input_image")
				: content;

			if (filteredContent.length > 0) {
				input.push({
					type: "message",
					role: "user",
					content: filteredContent,
				});
			}

			messageIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const assistantMessage = message as AssistantMessage;
			const isDifferentModel =
				assistantMessage.model !== model.id &&
				assistantMessage.provider === model.provider &&
				assistantMessage.api === model.api;

			const output: ResponseInput = [];

			for (const block of assistantMessage.content) {
				if (block.type === "thinking") {
					const thinkingBlock = block as ThinkingContent;
					if (!thinkingBlock.thinkingSignature) continue;
					output.push(JSON.parse(thinkingBlock.thinkingSignature) as ResponseReasoningItem);
					continue;
				}

				if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const messageId =
						parsedSignature?.id && parsedSignature.id.length <= 64 ? parsedSignature.id : `msg_${messageIndex}`;
					output.push({
						type: "message",
						role: "assistant",
						status: "completed",
						id: messageId,
						phase: parsedSignature?.phase,
						content: [{ type: "output_text", text: textBlock.text, annotations: [] }],
					} satisfies ResponseOutputMessage);
					continue;
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const normalizedId = normalizeToolCallId(model, toolCall.id);
					const [callId, itemIdRaw] = normalizedId.split("|");
					let itemId: string | undefined = itemIdRaw;
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}
					output.push({
						type: "function_call",
						call_id: callId,
						id: itemId,
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}

			input.push(...output);
			messageIndex++;
			continue;
		}

		if (message.role === "toolResult") {
			const textResult = message.content
				.filter((item): item is TextContent => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			const hasImages = message.content.some((item): item is ImageContent => item.type === "image");
			const [callId] = normalizeToolCallId(model, message.toolCallId).split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];
				if (textResult.length > 0) {
					contentParts.push({ type: "input_text", text: textResult });
				}
				for (const item of message.content) {
					if (item.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${item.mimeType};base64,${item.data}`,
						});
					}
				}
				output = contentParts;
			} else {
				output = textResult || "(see attached image)";
			}

			input.push({
				type: "function_call_output",
				call_id: callId,
				output,
			});
		}

		messageIndex++;
	}

	return input;
}

function getLatestCompactionEntry(
	branchEntries: SessionEntry[],
): { entry: CompactionEntry; index: number } | undefined {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry.type === "compaction") {
			return { entry, index };
		}
	}
	return undefined;
}

function buildFallbackCompactionSegment(
	branchEntries: SessionEntry[],
	model: CompactCapableModel,
): { entry: CompactionEntry; index: number; input: ResponseInput } | undefined {
	const latestCompaction = getLatestCompactionEntry(branchEntries);
	if (!latestCompaction) return undefined;

	const messages: AgentMessage[] = [createCompactionSummaryMessage(latestCompaction.entry)];
	let foundFirstKept = false;

	for (let index = 0; index < latestCompaction.index; index++) {
		const entry = branchEntries[index];
		if (entry.id === latestCompaction.entry.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (!foundFirstKept) continue;
		appendSessionEntryMessages(messages, entry);
	}

	return {
		...latestCompaction,
		input: convertMessagesToResponsesInput(model, messages),
	};
}

function buildPostCompactionInput(
	branchEntries: SessionEntry[],
	compactionIndex: number,
	model: CompactCapableModel,
): ResponseInput {
	const messages: AgentMessage[] = [];
	for (let index = compactionIndex + 1; index < branchEntries.length; index++) {
		appendSessionEntryMessages(messages, branchEntries[index]);
	}
	return convertMessagesToResponsesInput(model, messages);
}

function buildCurrentCompactionInput(branchEntries: SessionEntry[], model: CompactCapableModel): ResponseInput {
	const fallback = buildFallbackCompactionSegment(branchEntries, model);
	if (!fallback) {
		const messages: AgentMessage[] = [];
		for (const entry of branchEntries) {
			appendSessionEntryMessages(messages, entry);
		}
		return convertMessagesToResponsesInput(model, messages);
	}

	const details = fallback.entry.details;
	if (isStoredOpenAICompactWindow(details)) {
		return [...details.output, ...buildPostCompactionInput(branchEntries, fallback.index, model)];
	}

	return [...fallback.input, ...buildPostCompactionInput(branchEntries, fallback.index, model)];
}

function extractLeadingInstructionItems(input: ResponseInput): ResponseInput {
	const leading: ResponseInput = [];
	for (const item of input) {
		if (item.type === "message" && (item.role === "developer" || item.role === "system")) {
			leading.push(item);
			continue;
		}
		break;
	}
	return leading;
}

function rewritePayloadInputWithStoredCompaction(
	input: ResponseInput,
	branchEntries: SessionEntry[],
	model: CompactCapableModel,
): ResponseInput | undefined {
	const fallback = buildFallbackCompactionSegment(branchEntries, model);
	if (!fallback || !isStoredOpenAICompactWindow(fallback.entry.details)) {
		return undefined;
	}

	const leadingInstructions = extractLeadingInstructionItems(input);
	const remaining = input.slice(leadingInstructions.length);
	if (!startsWithItems(remaining, fallback.input)) {
		return undefined;
	}

	return [...leadingInstructions, ...fallback.entry.details.output, ...remaining.slice(fallback.input.length)];
}

function buildDisplaySummary(response: CompactedResponse, endpoint: string, modelId: string): string {
	const compactionItems = response.output.filter((item) => item.type === "compaction").length;
	const usageLine = response.usage
		? `Usage: ${response.usage.total_tokens} total tokens (${response.usage.input_tokens} in / ${response.usage.output_tokens} out).`
		: "Usage data unavailable.";

	return [
		`OpenAI compact window created with \`${modelId}\`.`,
		`Endpoint: ${endpoint}`,
		`Returned ${response.output.length} item(s), including ${compactionItems} compaction item(s).`,
		usageLine,
		"pi will replay the stored compacted window on future OpenAI Responses requests instead of this text summary.",
	].join("\n\n");
}

async function callCompactEndpoint(
	endpoint: string,
	apiKey: string | undefined,
	body: ResponseCompactParams,
	signal: AbortSignal,
): Promise<CompactedResponse> {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (apiKey) {
		headers.set("Authorization", `Bearer ${apiKey}`);
	}

	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Compact request failed (${response.status}): ${errorText || response.statusText}`);
	}

	const json = (await response.json()) as CompactedResponse;
	if (!Array.isArray(json.output)) {
		throw new Error("Compact response did not include an output window");
	}
	return json;
}

function isCompactCapableApi(api: Api | undefined): api is CompactCapableApi {
	return api === "openai-responses" || api === "openai-codex-responses";
}

export {
	buildCurrentCompactionInput,
	buildFallbackCompactionSegment,
	extractLeadingInstructionItems,
	resolveCompactUrl,
	rewritePayloadInputWithStoredCompaction,
	startsWithItems,
};

export default function openAICompactExtension(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		if (!ctx.model || !isCompactCapableApi(ctx.model.api)) {
			return;
		}

		const model = ctx.model as CompactCapableModel;
		const endpoint = resolveCompactUrl(process.env.PI_OPENAI_COMPACT_URL, model.baseUrl);
		const configuredApiKey = process.env.PI_OPENAI_COMPACT_API_KEY;
		const apiKey = configuredApiKey || (await ctx.modelRegistry.getApiKey(model));
		const input = buildCurrentCompactionInput(event.branchEntries, model);

		if (input.length === 0) {
			return;
		}

		try {
			ctx.ui.notify(`Compacting via ${endpoint}`, "info");

			const compactBody: ResponseCompactParams = {
				model: model.id,
				input,
				instructions: ctx.getSystemPrompt() || undefined,
				prompt_cache_key: ctx.sessionManager.getSessionId(),
			};

			const response = await callCompactEndpoint(endpoint, apiKey, compactBody, event.signal);
			const details: StoredOpenAICompactWindow = {
				type: "openai-compact-window",
				version: 1,
				endpoint,
				output: response.output,
				usage: response.usage
					? {
							inputTokens: response.usage.input_tokens,
							outputTokens: response.usage.output_tokens,
							totalTokens: response.usage.total_tokens,
						}
					: undefined,
			};

			return {
				compaction: {
					summary: buildDisplaySummary(response, endpoint, model.id),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details,
				},
			};
		} catch (error) {
			if (!event.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`OpenAI compact failed, falling back to default compaction: ${message}`, "warning");
			}
			return;
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!ctx.model || !isCompactCapableApi(ctx.model.api) || !isRecord(event.payload)) {
			return;
		}

		const model = ctx.model as CompactCapableModel;
		const currentInput = event.payload.input;
		if (!Array.isArray(currentInput)) {
			return;
		}

		const rewrittenInput = rewritePayloadInputWithStoredCompaction(
			currentInput as ResponseInput,
			ctx.sessionManager.getBranch(),
			model,
		);
		if (!rewrittenInput) {
			return;
		}

		return {
			...event.payload,
			input: rewrittenInput,
		};
	});
}
