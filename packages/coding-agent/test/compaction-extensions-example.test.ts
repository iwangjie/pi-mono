/**
 * Verify the documentation example from extensions.md compiles and works.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import {
	buildCurrentCompactionInput,
	buildFallbackCompactionSegment,
	extractLeadingInstructionItems,
	resolveCompactUrl,
	rewritePayloadInputWithStoredCompaction,
	startsWithItems,
} from "../examples/extensions/openai-compact.js";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionCompactEvent } from "../src/core/extensions/index.js";
import type { SessionEntry } from "../src/core/session-manager.js";

describe("Documentation example", () => {
	it("custom compaction example should type-check correctly", () => {
		// This is the example from extensions.md - verify it compiles
		const exampleExtension = (pi: ExtensionAPI) => {
			pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
				// All these should be accessible on the event
				const { preparation, branchEntries } = event;
				// sessionManager, modelRegistry, and model come from ctx
				const { sessionManager, modelRegistry } = ctx;
				const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, isSplitTurn } =
					preparation;

				// Verify types
				expect(Array.isArray(messagesToSummarize)).toBe(true);
				expect(Array.isArray(turnPrefixMessages)).toBe(true);
				expect(typeof isSplitTurn).toBe("boolean");
				expect(typeof tokensBefore).toBe("number");
				expect(typeof sessionManager.getEntries).toBe("function");
				expect(typeof modelRegistry.getApiKey).toBe("function");
				expect(typeof firstKeptEntryId).toBe("string");
				expect(Array.isArray(branchEntries)).toBe(true);

				const summary = messagesToSummarize
					.filter((m) => m.role === "user")
					.map((m) => `- ${typeof m.content === "string" ? m.content.slice(0, 100) : "[complex]"}`)
					.join("\n");

				// Extensions return compaction content - SessionManager adds id/parentId
				return {
					compaction: {
						summary: `User requests:\n${summary}`,
						firstKeptEntryId,
						tokensBefore,
					},
				};
			});
		};

		// Just verify the function exists and is callable
		expect(typeof exampleExtension).toBe("function");
	});

	it("compact event should have correct fields", () => {
		const checkCompactEvent = (pi: ExtensionAPI) => {
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				// These should all be accessible
				const entry = event.compactionEntry;
				const fromExtension = event.fromExtension;

				expect(entry.type).toBe("compaction");
				expect(typeof entry.summary).toBe("string");
				expect(typeof entry.tokensBefore).toBe("number");
				expect(typeof fromExtension).toBe("boolean");
			});
		};

		expect(typeof checkCompactEvent).toBe("function");
	});

	it("openai compact example should resolve proxy and OpenAI URLs", () => {
		const openAIModel: Model<"openai-responses"> = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const codexModel: Model<"openai-codex-responses"> = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		expect(resolveCompactUrl("http://127.0.0.1:8317/", openAIModel)).toBe(
			"http://127.0.0.1:8317/v1/responses/compact",
		);
		expect(resolveCompactUrl("https://api.openai.com/v1", openAIModel)).toBe(
			"https://api.openai.com/v1/responses/compact",
		);
		expect(resolveCompactUrl("https://proxy.example.com/v1/responses/compact", openAIModel)).toBe(
			"https://proxy.example.com/v1/responses/compact",
		);
		expect(resolveCompactUrl(undefined, codexModel)).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
	});

	it("openai compact example should replace fallback compaction prefix with stored window", () => {
		const model: Model<"openai-responses"> = {
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		const branchEntries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-03-18T00:00:00.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "first request" }],
					timestamp: Date.now(),
				},
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-03-18T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "first answer" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.1-codex-max",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "a1",
				timestamp: "2026-03-18T00:00:02.000Z",
				summary: "fallback summary",
				firstKeptEntryId: "a1",
				tokensBefore: 1234,
				details: {
					type: "openai-compact-window",
					version: 1,
					endpoint: "http://127.0.0.1:8317/v1/responses/compact",
					output: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "stored compacted window" }],
						},
						{
							type: "compaction",
							encrypted_content: "opaque",
						},
					],
				},
			},
			{
				type: "message",
				id: "u2",
				parentId: "c1",
				timestamp: "2026-03-18T00:00:03.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "new request" }],
					timestamp: Date.now(),
				},
			},
		];

		const fallback = buildFallbackCompactionSegment(branchEntries, model);
		expect(fallback).toBeDefined();
		expect(startsWithItems((fallback?.input || []).slice(0, 1), (fallback?.input || []).slice(0, 1))).toBe(true);

		const payloadInput: ResponseInput = [
			...extractLeadingInstructionItems([
				{
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text: "system prompt" }],
				},
				...(fallback?.input || []),
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "new request" }],
				},
			]),
			...(fallback?.input || []),
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "new request" }],
			},
		];

		expect(payloadInput.length).toBeGreaterThan(1);

		const rewrittenInput = rewritePayloadInputWithStoredCompaction(payloadInput, branchEntries, model);
		expect(rewrittenInput).toEqual([
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "system prompt" }],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "stored compacted window" }],
			},
			{
				type: "compaction",
				encrypted_content: "opaque",
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "new request" }],
			},
		]);

		const currentInput = buildCurrentCompactionInput(branchEntries, model);
		expect(currentInput[0]).toEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "stored compacted window" }],
		});
		expect(currentInput[1]).toEqual({
			type: "compaction",
			encrypted_content: "opaque",
		});
		expect(currentInput[2]).toEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "new request" }],
		});
	});
});
