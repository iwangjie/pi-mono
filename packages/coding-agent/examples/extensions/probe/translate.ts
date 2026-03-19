const PROBE_TRANSLATE_ENDPOINT = "https://api.chibanban.de/v1/chat/completions";
const PROBE_TRANSLATE_MODEL = "tencent/Hunyuan-MT-7B";
const PROBE_TRANSLATE_TIMEOUT_MS = 8_000;
const PROBE_DEEPLX_BASE_URL = "https://api.deeplx.org";

export interface ProbeTranslationResult {
	attempted: boolean;
	applied: boolean;
	source_language: "zh" | "mixed" | "other";
	translated_terms: string[];
	provider?: "llm" | "deeplx";
	skipped_reason?: string;
}

function detectSourceLanguage(query: string): ProbeTranslationResult["source_language"] {
	const hasChinese = /[\u4e00-\u9fff]/.test(query);
	const hasAscii = /[A-Za-z]/.test(query);
	if (hasChinese && hasAscii) {
		return "mixed";
	}
	if (hasChinese) {
		return "zh";
	}
	return "other";
}

function splitQueryTerms(query: string): string[] {
	return query
		.split(/[\s,，。;；:：/|()[\]{}"'`<>!?！？]+/)
		.map((term) => term.trim())
		.filter((term) => term.length >= 2)
		.slice(0, 12);
}

function looksLikeIdentifier(term: string): boolean {
	return (
		/[A-Z_]/.test(term) ||
		/[a-z][A-Z]/.test(term) ||
		/\d/.test(term) ||
		term.includes("_") ||
		term.toLowerCase().includes("req") ||
		term.toLowerCase().includes("service") ||
		term.toLowerCase().includes("controller") ||
		term.toLowerCase().includes("funcode")
	);
}

function shouldTranslateQuery(query: string): boolean {
	const sourceLanguage = detectSourceLanguage(query);
	if (sourceLanguage === "other") {
		return false;
	}
	return !splitQueryTerms(query).some(looksLikeIdentifier);
}

function sanitizeTranslatedTerms(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return Array.from(
		new Set(
			value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter((item) => /^[A-Za-z][A-Za-z0-9_ -]{1,63}$/.test(item)),
		),
	).slice(0, 8);
}

function parseJsonContent(content: string): unknown {
	const trimmed = content
		.trim()
		.replace(/^```json\s*/i, "")
		.replace(/^```\s*/i, "")
		.replace(/\s*```$/, "");
	return JSON.parse(trimmed);
}

function resolveDeeplxTranslateUrl(): string | undefined {
	const configuredBaseUrl = process.env.PI_CHAT_TRANSLATE_DEEPLX_BASE_URL?.trim() || PROBE_DEEPLX_BASE_URL;
	const deeplxKey = process.env.PI_CHAT_TRANSLATE_DEEPLX_KEY?.trim();
	if (!deeplxKey) {
		return undefined;
	}

	return `${configuredBaseUrl.replace(/\/+$/, "")}/${deeplxKey}/translate`;
}

async function translateWithLlm(
	query: string,
	apiKey: string,
	signal: AbortSignal,
	sourceLanguage: ProbeTranslationResult["source_language"],
): Promise<ProbeTranslationResult> {
	const response = await fetch(PROBE_TRANSLATE_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: PROBE_TRANSLATE_MODEL,
			temperature: 0,
			messages: [
				{
					role: "system",
					content:
						'You translate Chinese software search keywords into short English code-search terms for Java, Spring, Maven, and JSP codebases. Return strict JSON only: {"terms":["term1","term2"]}. Rules: output 2 to 8 short English technical terms or identifiers, no Chinese, no sentences, no markdown, no explanation.',
				},
				{
					role: "user",
					content: JSON.stringify({
						query,
						context:
							"Probe code search for Java/Spring projects. Translate Chinese search terms into likely English code-search keywords and identifiers.",
						keywords: splitQueryTerms(query),
					}),
				},
			],
		}),
		signal,
	});

	if (!response.ok) {
		return {
			attempted: true,
			applied: false,
			source_language: sourceLanguage,
			translated_terms: [],
			provider: "llm",
			skipped_reason: `llm_http_${response.status}`,
		};
	}

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = data.choices?.[0]?.message?.content;
	if (!content) {
		return {
			attempted: true,
			applied: false,
			source_language: sourceLanguage,
			translated_terms: [],
			provider: "llm",
			skipped_reason: "llm_empty_response",
		};
	}

	const parsed = parseJsonContent(content) as { terms?: unknown };
	const translatedTerms = sanitizeTranslatedTerms(parsed.terms);
	return {
		attempted: true,
		applied: translatedTerms.length > 0,
		source_language: sourceLanguage,
		translated_terms: translatedTerms,
		provider: "llm",
		skipped_reason: translatedTerms.length > 0 ? undefined : "llm_no_terms",
	};
}

async function translateWithDeeplx(
	query: string,
	signal: AbortSignal,
	sourceLanguage: ProbeTranslationResult["source_language"],
): Promise<ProbeTranslationResult> {
	const deeplxUrl = resolveDeeplxTranslateUrl();
	if (!deeplxUrl) {
		return {
			attempted: false,
			applied: false,
			source_language: sourceLanguage,
			translated_terms: [],
			provider: "deeplx",
			skipped_reason: "missing_deeplx_key",
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
			source_lang: sourceLanguage === "other" ? "AUTO" : "ZH",
			target_lang: "EN",
			text: query,
		}),
		signal,
	});

	if (!response.ok) {
		return {
			attempted: true,
			applied: false,
			source_language: sourceLanguage,
			translated_terms: [],
			provider: "deeplx",
			skipped_reason: `deeplx_http_${response.status}`,
		};
	}

	const data = (await response.json()) as {
		code?: number;
		data?: unknown;
		alternatives?: unknown;
	};
	const primaryText = typeof data.data === "string" ? data.data : "";
	const alternatives = Array.isArray(data.alternatives)
		? data.alternatives.filter((value): value is string => typeof value === "string")
		: [];
	const translatedTerms = sanitizeTranslatedTerms(
		[primaryText, ...alternatives]
			.flatMap((value) => value.split(/[\s,，。;；:：/|()[\]{}"'`<>!?！？-]+/))
			.filter((value) => value.trim().length > 0),
	);

	return {
		attempted: true,
		applied: translatedTerms.length > 0,
		source_language: sourceLanguage,
		translated_terms: translatedTerms,
		provider: "deeplx",
		skipped_reason: translatedTerms.length > 0 ? undefined : "deeplx_no_terms",
	};
}

export async function maybeTranslateProbeTerms(
	query: string,
	signal: AbortSignal | undefined,
): Promise<ProbeTranslationResult> {
	const sourceLanguage = detectSourceLanguage(query);
	if (!shouldTranslateQuery(query)) {
		return {
			attempted: false,
			applied: false,
			source_language: sourceLanguage,
			translated_terms: [],
			skipped_reason: "query_already_contains_code_identifiers_or_is_not_chinese",
		};
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROBE_TRANSLATE_TIMEOUT_MS);
	const abortListener = () => controller.abort();
	signal?.addEventListener("abort", abortListener, { once: true });

	try {
		const apiKey = process.env.PI_CHAT_TRANSLATE_API_KEY?.trim();
		if (apiKey) {
			const llmResult = await translateWithLlm(query, apiKey, controller.signal, sourceLanguage);
			if (llmResult.applied) {
				return llmResult;
			}

			const deeplxResult = await translateWithDeeplx(query, controller.signal, sourceLanguage);
			if (deeplxResult.applied) {
				return deeplxResult;
			}

			return {
				attempted: true,
				applied: false,
				source_language: sourceLanguage,
				translated_terms: [],
				skipped_reason: `${llmResult.skipped_reason ?? "llm_failed"};${deeplxResult.skipped_reason ?? "deeplx_failed"}`,
			};
		}

		return await translateWithDeeplx(query, controller.signal, sourceLanguage);
	} catch {
		try {
			return await translateWithDeeplx(query, controller.signal, sourceLanguage);
		} catch {}

		return {
			attempted: true,
			applied: false,
			source_language: sourceLanguage,
			translated_terms: [],
			skipped_reason: "llm_and_deeplx_request_failed",
		};
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abortListener);
	}
}
