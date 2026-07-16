import { activityMonitor } from "./activity.ts";
import { getWebAccessConfiguration, type WebAccessSettings } from "./configuration.ts";
import {
	getApiKey,
	getVersionedApiBase,
	buildKeyParam,
	buildAuthHeaders,
	isGatewayConfigured,
	isGeminiApiAvailable,
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

export type {
	AttributedSearchResponse,
	FullSearchOptions,
	ResolvedSearchProvider,
	SearchProvider,
} from "./search-provider.ts";

type GeminiSearchSettings = Pick<WebAccessSettings,
	"provider" | "searchProvider" | "searchModel" | "geminiApiKey" | "geminiBaseUrl" |
	"cloudflareApiKey" | "allowBrowserCookies" | "chromeProfile"
>;

function currentSettings(settings?: GeminiSearchSettings): GeminiSearchSettings {
	return settings ?? getWebAccessConfiguration().current();
}

function getSearchConfig(settings?: GeminiSearchSettings): { searchProvider: SearchProvider; searchModel: string } {
	const captured = currentSettings(settings);
	return {
		searchProvider: captured.searchProvider ?? captured.provider,
		searchModel: captured.searchModel,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function throwIfCallerCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) signal.throwIfAborted();
}

async function searchWithGemini(
	query: string,
	options: SearchOptions,
	settings?: GeminiSearchSettings,
): Promise<SearchResponse> {
	const errors: string[] = [];

	try {
		const apiResult = await searchWithGeminiApi(query, options, settings);
		throwIfCallerCancelled(options.signal);
		if (apiResult) return apiResult;
	} catch (error) {
		throwIfCallerCancelled(options.signal);
		errors.push(`Gemini API: ${errorMessage(error)}`);
	}

	try {
		const webResult = await searchWithGeminiWeb(query, options, settings);
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
		`  1. Set GEMINI_API_KEY in ${getWebAccessConfiguration().sourcePath}\n` +
		"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
		"  3. Sign into gemini.google.com in a supported Chromium-based browser",
	);
}

/** Creates a Gemini provider that closes over one immutable settings snapshot. */
export function createGeminiSearchProvider(settings?: GeminiSearchSettings): SearchProviderAdapter<"gemini"> {
	return {
		name: "gemini",
		label: "Gemini",
		eligibility: async () => isGeminiApiAvailable(settings) || !!(await isGeminiWebAvailable(undefined, settings))
			? { eligible: true }
			: { eligible: false, reason: "Gemini API, gateway, and browser credentials are not available." },
		search: ({ query, options }) => searchWithGemini(query, options, settings),
	};
}

/** Backwards-compatible Gemini adapter that resolves process configuration per operation. */
export const geminiSearchProvider: SearchProviderAdapter<"gemini"> = createGeminiSearchProvider();

/** @deprecated Use the extension-registered Web search tool. */
export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const { createConfiguredWebSearch } = await import("./web-search.ts");
	const webSearch = createConfiguredWebSearch(getWebAccessConfiguration().current());
	return webSearch.search(query, {
		...options,
		provider: options.provider ?? config.searchProvider,
	});
}

async function searchWithGeminiApi(
	query: string,
	options: SearchOptions = {},
	settings?: GeminiSearchSettings,
): Promise<SearchResponse | null> {
	const apiKey = getApiKey(settings);
	if (!apiKey && !isGatewayConfigured(settings)) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchConfig(settings).searchModel;
		const body = {
			contents: [{ role: "user", parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetch(`${getVersionedApiBase(settings)}/models/${model}:generateContent${buildKeyParam(apiKey, settings)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...buildAuthHeaders(settings) },
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

async function searchWithGeminiWeb(
	query: string,
	options: SearchOptions = {},
	settings?: GeminiSearchSettings,
): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable(undefined, settings);
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
