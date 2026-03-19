import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { translateDisplayToChinese, translatePromptToEnglish } from "./translate.js";

const DISPLAY_CACHE_ENTRY_TYPE = "chat-translate-display";
const PROMPT_STATUS_KEY = "chat-translate-prompt";
const OUTPUT_STATUS_KEY = "chat-translate-output";

interface UserDisplayCache {
	kind: "user";
	text: string;
}

interface AssistantDisplayCache {
	kind: "assistant";
	textBlocks: string[];
	thinkingBlocks: string[];
	errorMessage?: string;
}

type DisplayCacheValue = UserDisplayCache | AssistantDisplayCache;
type UserAgentMessage = Extract<AgentMessage, { role: "user" }>;

interface PersistedDisplayCacheEntry {
	sessionId: string;
	role: "user" | "assistant";
	timestamp: number;
	value: DisplayCacheValue;
}

function containsChinese(text: string): boolean {
	return /[\u4e00-\u9fff]/.test(text);
}

function formatTranslationFailure(skippedReason: string | undefined): string {
	if (!skippedReason) {
		return "unknown_error";
	}

	switch (skippedReason) {
		case "missing_deeplx_key":
			return "missing translator config. Set PI_CHAT_TRANSLATE_API_KEY or PI_CHAT_TRANSLATE_DEEPLX_KEY.";
		case "llm_and_deeplx_request_failed":
			return "translator request failed";
		default:
			return skippedReason;
	}
}

function getMessageKey(sessionId: string, role: "user" | "assistant", timestamp: number): string {
	return `${sessionId}:${role}:${timestamp}`;
}

function getCacheKey(sessionId: string, message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") {
		return undefined;
	}
	return getMessageKey(sessionId, message.role, message.timestamp);
}

function replaceUserDisplayText(message: UserAgentMessage, text: string): UserAgentMessage {
	if (typeof message.content === "string") {
		return {
			...message,
			content: text,
		};
	}

	return {
		...message,
		content: [{ type: "text", text }, ...message.content.filter((content) => content.type !== "text")],
	};
}

function applyAssistantDisplay(message: AssistantMessage, value: AssistantDisplayCache): AssistantMessage {
	let textIndex = 0;
	let thinkingIndex = 0;

	return {
		...message,
		content: message.content.map((content) => {
			if (content.type === "text") {
				const translatedText = value.textBlocks[textIndex] ?? "";
				textIndex += 1;
				return { ...content, text: translatedText };
			}
			if (content.type === "thinking") {
				const translatedThinking = value.thinkingBlocks[thinkingIndex] ?? "";
				thinkingIndex += 1;
				return { ...content, thinking: translatedThinking };
			}
			return content;
		}),
		errorMessage: value.errorMessage ?? message.errorMessage,
	};
}

function loadPersistedDisplayCache(
	ctx: ExtensionContext,
	displayCache: Map<string, DisplayCacheValue>,
	persistedKeys: Set<string>,
): void {
	displayCache.clear();
	persistedKeys.clear();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== DISPLAY_CACHE_ENTRY_TYPE) {
			continue;
		}

		const data = entry.data as PersistedDisplayCacheEntry | undefined;
		if (!data || (data.role !== "user" && data.role !== "assistant")) {
			continue;
		}

		const key = getMessageKey(data.sessionId, data.role, data.timestamp);
		displayCache.set(key, data.value);
		persistedKeys.add(key);
	}
}

export default function chatTranslateExtension(pi: ExtensionAPI) {
	const displayCache = new Map<string, DisplayCacheValue>();
	const persistedKeys = new Set<string>();
	const pendingUserDisplayTexts: string[] = [];
	const inFlightAssistantKeys = new Set<string>();
	let currentSessionId = "";

	const refreshCache = (ctx: ExtensionContext) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		loadPersistedDisplayCache(ctx, displayCache, persistedKeys);
	};

	pi.registerMessageDisplayTransformer((message) => {
		const key = getCacheKey(currentSessionId, message);
		if (!key) {
			return undefined;
		}

		const value = displayCache.get(key);
		if (!value) {
			return undefined;
		}

		if (message.role === "user" && value.kind === "user") {
			return replaceUserDisplayText(message, value.text);
		}

		if (message.role === "assistant" && value.kind === "assistant") {
			return applyAssistantDisplay(message, value);
		}

		return undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		pendingUserDisplayTexts.length = 0;
		refreshCache(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		pendingUserDisplayTexts.length = 0;
		refreshCache(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		pendingUserDisplayTexts.length = 0;
		refreshCache(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const text = event.text.trim();
		if (!text || text.startsWith("/") || text.startsWith("!")) {
			return { action: "continue" };
		}

		if (!containsChinese(event.text)) {
			return { action: "continue" };
		}

		ctx.ui.setStatus(PROMPT_STATUS_KEY, "Translating prompt to English...");
		try {
			const result = await translatePromptToEnglish(event.text);
			if (!result.applied || !result.text.trim()) {
				ctx.ui.notify(`Prompt translation failed: ${formatTranslationFailure(result.skippedReason)}`, "error");
				return { action: "handled" };
			}

			pendingUserDisplayTexts.push(event.text);
			return {
				action: "transform",
				text: result.text,
				images: event.images,
			};
		} catch {
			ctx.ui.notify("Prompt translation failed: translator request threw an exception", "error");
			return { action: "handled" };
		} finally {
			ctx.ui.setStatus(PROMPT_STATUS_KEY, undefined);
		}
	});

	pi.on("message_start", (event, _ctx) => {
		if (event.message.role !== "user") {
			return;
		}

		const key = getCacheKey(currentSessionId, event.message);
		if (!key) {
			return;
		}

		const originalText = pendingUserDisplayTexts.shift();
		if (originalText) {
			displayCache.set(key, {
				kind: "user",
				text: originalText,
			});
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "user") {
			const sessionId = currentSessionId;
			const key = getCacheKey(sessionId, event.message);
			const value = key ? displayCache.get(key) : undefined;
			if (key && value?.kind === "user" && !persistedKeys.has(key)) {
				pi.appendEntry(DISPLAY_CACHE_ENTRY_TYPE, {
					sessionId,
					role: "user",
					timestamp: event.message.timestamp,
					value,
				} satisfies PersistedDisplayCacheEntry);
				persistedKeys.add(key);
			}
			return;
		}

		if (event.message.role !== "assistant") {
			return;
		}

		const sessionId = currentSessionId;
		const key = getCacheKey(sessionId, event.message);
		if (!key || inFlightAssistantKeys.has(key)) {
			return;
		}

		const assistantMessage = event.message;
		inFlightAssistantKeys.add(key);
		ctx.ui.setStatus(OUTPUT_STATUS_KEY, "Translating response to Chinese...");
		try {
			const textBlocks = await Promise.all(
				assistantMessage.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map(async (content) => {
						if (!content.text.trim()) {
							return content.text;
						}
						const result = await translateDisplayToChinese(content.text);
						return result.applied ? result.text : content.text;
					}),
			);

			const thinkingBlocks = await Promise.all(
				assistantMessage.content
					.filter((content): content is { type: "thinking"; thinking: string } => content.type === "thinking")
					.map(async (content) => {
						if (!content.thinking.trim()) {
							return content.thinking;
						}
						const result = await translateDisplayToChinese(content.thinking);
						return result.applied ? result.text : content.thinking;
					}),
			);

			let translatedErrorMessage = assistantMessage.errorMessage;
			if (translatedErrorMessage?.trim()) {
				const result = await translateDisplayToChinese(translatedErrorMessage);
				if (result.applied) {
					translatedErrorMessage = result.text;
				}
			}

			const value: AssistantDisplayCache = {
				kind: "assistant",
				textBlocks,
				thinkingBlocks,
				errorMessage: translatedErrorMessage,
			};
			displayCache.set(key, value);

			if (!persistedKeys.has(key)) {
				pi.appendEntry(DISPLAY_CACHE_ENTRY_TYPE, {
					sessionId,
					role: "assistant",
					timestamp: assistantMessage.timestamp,
					value,
				} satisfies PersistedDisplayCacheEntry);
				persistedKeys.add(key);
			}
		} catch {
			displayCache.delete(key);
			ctx.ui.notify("Assistant translation failed. Showing original English output.", "warning");
		} finally {
			inFlightAssistantKeys.delete(key);
			ctx.ui.setStatus(OUTPUT_STATUS_KEY, undefined);
		}
	});
}
