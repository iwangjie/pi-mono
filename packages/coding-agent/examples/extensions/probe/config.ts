import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProbeSynonymMap = Record<string, string[]>;

const DEFAULT_PROJECT_SYNONYM_PATHS = [
	".pi/extensions/probe/synonyms.json",
	".pi/probe/synonyms.json",
	".probe-synonyms.json",
] as const;

function normalizeSynonymMap(data: unknown): ProbeSynonymMap {
	if (!data || typeof data !== "object") {
		return {};
	}

	const result: ProbeSynonymMap = {};
	for (const [key, value] of Object.entries(data)) {
		if (typeof key !== "string") {
			continue;
		}
		if (!Array.isArray(value)) {
			continue;
		}

		const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		if (items.length > 0) {
			result[key] = items;
		}
	}

	return result;
}

export function loadProjectProbeSynonyms(cwd: string): ProbeSynonymMap {
	for (const relativePath of DEFAULT_PROJECT_SYNONYM_PATHS) {
		const absolutePath = join(cwd, relativePath);
		if (!existsSync(absolutePath)) {
			continue;
		}

		try {
			const raw = readFileSync(absolutePath, "utf8");
			return normalizeSynonymMap(JSON.parse(raw));
		} catch {
			return {};
		}
	}

	return {};
}
