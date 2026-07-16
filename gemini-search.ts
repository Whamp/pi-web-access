import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import {
	getApiKey,
	getVersionedApiBase,
	buildKeyParam,
	buildAuthHeaders,
	isGatewayConfigured,
	isGeminiApiAvailable,
	DEFAULT_MODEL,
} from "./gemini-api.ts";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.ts";
import type {
	AttributedSearchResponse,
	FullSearchOptions,
	SearchOptions,
	SearchProvider,
	SearchProviderAdapter,
	SearchResponse,
	SearchResult,
} from "./search-provider.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export type {
	AttributedSearchResponse,
	FullSearchOptions,
	ResolvedSearchProvider,
	SearchProvider,
} from "./search-provider.ts";

const CONFIG_PATH = getWebSearchConfigPath();
let cachedSearchConfig: { searchProvider: SearchProvider; searchModel?: string } | null = null;

function normalizeSearchProvider(value: unknown): SearchProvider {
	if (typeof value !== "string") return "auto";
	switch (value.trim().toLowerCase()) {
		case "auto": return "auto";
		case "openai": return "openai";
		case "exa": return "exa";
		case "brave": return "brave";
		case "parallel": return "parallel";
		case "tavily": return "tavily";
		case "perplexity": return "perplexity";
		case "gemini": return "gemini";
		default: return "auto";
	}
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function getSearchConfig(): { searchProvider: SearchProvider; searchModel?: string } {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto" };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	const searchProvider = parsed !== null && typeof parsed === "object"
		? Reflect.get(parsed, "searchProvider") ?? Reflect.get(parsed, "provider")
		: undefined;
	const searchModel = parsed !== null && typeof parsed === "object"
		? Reflect.get(parsed, "searchModel")
		: undefined;
	cachedSearchConfig = {
		searchProvider: normalizeSearchProvider(searchProvider),
		searchModel: normalizeSearchModel(searchModel),
	};
	return cachedSearchConfig;
}

function getSearchModel(): string {
	return getSearchConfig().searchModel ?? DEFAULT_MODEL;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function throwIfCallerCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) signal.throwIfAborted();
}

async function searchWithGemini(query: string, options: SearchOptions): Promise<SearchResponse> {
	const errors: string[] = [];

	try {
		const apiResult = await searchWithGeminiApi(query, options);
		throwIfCallerCancelled(options.signal);
		if (apiResult) return apiResult;
	} catch (error) {
		throwIfCallerCancelled(options.signal);
		errors.push(`Gemini API: ${errorMessage(error)}`);
	}

	try {
		const webResult = await searchWithGeminiWeb(query, options);
		throwIfCallerCancelled(options.signal);
		if (webResult) return webResult;
	} catch (error) {
		throwIfCallerCancelled(options.signal);
		errors.push(`Gemini Web: ${errorMessage(error)}`);
	}

	if (errors.length > 0) {
		throw new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`);
	}

	throw new Error(
		"Gemini search unavailable. Either:\n" +
		`  1. Set GEMINI_API_KEY in ${CONFIG_PATH}\n` +
		"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
		"  3. Sign into gemini.google.com in a supported Chromium-based browser",
	);
}

export const geminiSearchProvider: SearchProviderAdapter<"gemini"> = {
	name: "gemini",
	label: "Gemini",
	eligibility: async () => isGeminiApiAvailable() || !!(await isGeminiWebAvailable())
		? { eligible: true }
		: { eligible: false, reason: "Gemini API, gateway, and browser credentials are not available." },
	search: ({ query, options }) => searchWithGemini(query, options),
};

/** @deprecated Use the extension-registered Web search tool. */
export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const [{ createWebAccessConfiguration }, { createConfiguredWebSearch }] = await Promise.all([
		import("./configuration.ts"),
		import("./web-search.ts"),
	]);
	const webSearch = createConfiguredWebSearch(createWebAccessConfiguration().current());
	return webSearch.search(query, {
		...options,
		provider: options.provider ?? config.searchProvider,
	});
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey && !isGatewayConfigured()) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchModel();
		const body = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetch(`${getVersionedApiBase()}/models/${model}:generateContent${buildKeyParam(apiKey)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
			body: JSON.stringify(body),
			signal: AbortSignal.any([
				AbortSignal.timeout(60000),
				...(options.signal ? [options.signal] : []),
			]),
		});

		if (!res.ok) {
			const errorText = await res.text();
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await res.json() as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer = data.candidates?.[0]?.content?.parts
			?.map(p => p.text).filter(Boolean).join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);

		if (!answer && results.length === 0) return null;
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

async function searchWithGeminiWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const prompt = buildSearchPrompt(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const text = await queryWithCookies(prompt, cookies, {
			model: "gemini-3-flash-preview",
			signal: options.signal,
			timeoutMs: 60000,
		});

		activityMonitor.logComplete(activityId, 200);

		const results = extractSourceUrls(text);
		return { answer: text, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

function buildSearchPrompt(query: string, options: SearchOptions): string {
	let prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}

	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter(d => !d.startsWith("-"));
		const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
		if (includes.length) prompt += `\n\nOnly cite sources from: ${includes.join(", ")}`;
		if (excludes.length) prompt += `\n\nDo not cite sources from: ${excludes.join(", ")}`;
	}

	return prompt;
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of markdown.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}
	return results;
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
			const resolved = await resolveRedirect(url, signal);
			if (resolved) url = resolved;
		}

		if (url) results.push({ title, url, snippet: "" });
	}
	return results;
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([
				AbortSignal.timeout(5000),
				...(signal ? [signal] : []),
			]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
