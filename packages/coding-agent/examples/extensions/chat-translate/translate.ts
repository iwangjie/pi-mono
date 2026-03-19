const CHAT_TRANSLATE_ENDPOINT = "https://api.chibanban.de/v1/chat/completions";
const CHAT_TRANSLATE_MODEL = "tencent/Hunyuan-MT-7B";
const CHAT_TRANSLATE_TIMEOUT_MS = 12_000;
const CHAT_TRANSLATE_DEEPLX_BASE_URL = "https://api.deeplx.org";

type TranslationProvider = "llm" | "deeplx";
type TranslationDirection = "prompt_to_en" | "display_to_zh";

export interface ChatTranslationResult {
	attempted: boolean;
	applied: boolean;
	text: string;
	provider?: TranslationProvider;
	skippedReason?: string;
}

function toErrorReason(prefix: "llm" | "deeplx", error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.replace(/\s+/g, "_").slice(0, 120);
		return `${prefix}_exception_${message || error.name || "error"}`;
	}
	return `${prefix}_exception_unknown`;
}

function containsChinese(text: string): boolean {
	return /[\u4e00-\u9fff]/.test(text);
}

function resolveDeeplxTranslateUrl(): string | undefined {
	const configuredBaseUrl = process.env.PI_CHAT_TRANSLATE_DEEPLX_BASE_URL?.trim() || CHAT_TRANSLATE_DEEPLX_BASE_URL;
	const deeplxKey = process.env.PI_CHAT_TRANSLATE_DEEPLX_KEY?.trim();
	if (!deeplxKey) {
		return undefined;
	}

	return `${configuredBaseUrl.replace(/\/+$/, "")}/${deeplxKey}/translate`;
}

function sanitizeEnglishPrompt(text: string): string {
	return text.replace(/\r\n/g, "\n").trim();
}

function parseJsonContent(content: string): unknown {
	const trimmed = content
		.trim()
		.replace(/^```json\s*/i, "")
		.replace(/^```\s*/i, "")
		.replace(/\s*```$/, "");
	return JSON.parse(trimmed);
}

function getSystemPrompt(direction: TranslationDirection): string {
	if (direction === "prompt_to_en") {
		return [
			"You rewrite user prompts for an English-only coding assistant.",
			'Return strict JSON only: {"text":"..."}.',
			"Rules:",
			"- Output only optimized plain English for the assistant.",
			"- Preserve intent, constraints, file paths, code, URLs, and technical identifiers.",
			"- Remove Chinese completely.",
			"- Keep the prompt concise but complete.",
			"- No markdown fences, no commentary, no explanations.",
		].join(" ");
	}

	return [
		"You translate assistant output into Simplified Chinese for display.",
		"Translate only natural language prose.",
		"Preserve markdown structure, code fences, inline code, paths, commands, URLs, JSON keys, and identifiers.",
		"Return the translated content only.",
	].join(" ");
}

async function translateWithLlm(
	text: string,
	direction: TranslationDirection,
	apiKey: string,
	signal: AbortSignal,
): Promise<ChatTranslationResult> {
	const response = await fetch(CHAT_TRANSLATE_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: CHAT_TRANSLATE_MODEL,
			temperature: 0,
			messages: [
				{
					role: "system",
					content: getSystemPrompt(direction),
				},
				{
					role: "user",
					content:
						direction === "prompt_to_en"
							? JSON.stringify({
									prompt: text,
									context: "The rewritten prompt will be sent to an English-only coding agent.",
								})
							: text,
				},
			],
		}),
		signal,
	});

	if (!response.ok) {
		return {
			attempted: true,
			applied: false,
			text,
			provider: "llm",
			skippedReason: `llm_http_${response.status}`,
		};
	}

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = data.choices?.[0]?.message?.content?.trim();
	if (!content) {
		return {
			attempted: true,
			applied: false,
			text,
			provider: "llm",
			skippedReason: "llm_empty_response",
		};
	}

	const translatedText =
		direction === "prompt_to_en"
			? sanitizeEnglishPrompt(((parseJsonContent(content) as { text?: unknown }).text as string | undefined) ?? "")
			: content;

	if (!translatedText) {
		return {
			attempted: true,
			applied: false,
			text,
			provider: "llm",
			skippedReason: "llm_empty_translation",
		};
	}

	if (direction === "prompt_to_en" && containsChinese(translatedText)) {
		return {
			attempted: true,
			applied: false,
			text,
			provider: "llm",
			skippedReason: "llm_prompt_still_contains_chinese",
		};
	}

	return {
		attempted: true,
		applied: true,
		text: translatedText,
		provider: "llm",
	};
}

async function translateWithDeeplx(
	text: string,
	direction: TranslationDirection,
	signal: AbortSignal,
): Promise<ChatTranslationResult> {
	const deeplxUrl = resolveDeeplxTranslateUrl();
	if (!deeplxUrl) {
		return {
			attempted: false,
			applied: false,
			text,
			provider: "deeplx",
			skippedReason: "missing_deeplx_key",
		};
	}

	const response = await fetch(deeplxUrl, {
		method: "POST",
		headers: {
			Accept: "*/*",
			"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			"Content-Type": "application/json",
			DNT: "1",
			Origin: "chrome-extension://lhhomihflaaecjpnnanjgjgdcncdjimc",
			Priority: "u=1, i",
			"Sec-Fetch-Dest": "empty",
			"Sec-Fetch-Mode": "cors",
			"Sec-Fetch-Site": "none",
			"Sec-Fetch-Storage-Access": "active",
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		},
		body: JSON.stringify({
			source_lang: direction === "prompt_to_en" ? "ZH" : "EN",
			target_lang: direction === "prompt_to_en" ? "EN" : "ZH",
			text,
		}),
		signal,
	});

	if (!response.ok) {
		return {
			attempted: true,
			applied: false,
			text,
			provider: "deeplx",
			skippedReason: `deeplx_http_${response.status}`,
		};
	}

	const data = (await response.json()) as {
		data?: unknown;
	};
	const translatedText = typeof data.data === "string" ? data.data.trim() : "";
	if (!translatedText) {
		return {
			attempted: true,
			applied: false,
			text,
			provider: "deeplx",
			skippedReason: "deeplx_empty_translation",
		};
	}

	if (direction === "prompt_to_en" && containsChinese(translatedText)) {
		return {
			attempted: true,
			applied: false,
			text,
			provider: "deeplx",
			skippedReason: "deeplx_prompt_still_contains_chinese",
		};
	}

	return {
		attempted: true,
		applied: true,
		text: direction === "prompt_to_en" ? sanitizeEnglishPrompt(translatedText) : translatedText,
		provider: "deeplx",
	};
}

async function translateText(text: string, direction: TranslationDirection): Promise<ChatTranslationResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CHAT_TRANSLATE_TIMEOUT_MS);

	try {
		const apiKey = process.env.PI_CHAT_TRANSLATE_API_KEY?.trim();
		let llmSkippedReason: string | undefined;
		if (apiKey) {
			try {
				const llmResult = await translateWithLlm(text, direction, apiKey, controller.signal);
				if (llmResult.applied) {
					return llmResult;
				}
				llmSkippedReason = llmResult.skippedReason;
			} catch (error) {
				llmSkippedReason = toErrorReason("llm", error);
			}
		}

		try {
			const deeplxResult = await translateWithDeeplx(text, direction, controller.signal);
			if (deeplxResult.applied) {
				return deeplxResult;
			}
			return {
				...deeplxResult,
				skippedReason: [llmSkippedReason, deeplxResult.skippedReason].filter(Boolean).join(";") || undefined,
			};
		} catch (error) {
			return {
				attempted: true,
				applied: false,
				text,
				skippedReason: [llmSkippedReason, toErrorReason("deeplx", error)].filter(Boolean).join(";"),
			};
		}
	} finally {
		clearTimeout(timeout);
	}
}

export async function translatePromptToEnglish(text: string): Promise<ChatTranslationResult> {
	return translateText(text, "prompt_to_en");
}

export async function translateDisplayToChinese(text: string): Promise<ChatTranslationResult> {
	return translateText(text, "display_to_zh");
}
