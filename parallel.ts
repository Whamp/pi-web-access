import { activityMonitor } from "./activity.ts";
import { settleWithAbort } from "./abort.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { abandonResponseBody, readResponseBytes } from "./response-body.ts";
import type { SearchOptions, SearchProviderAdapter, SearchResponse } from "./search-provider.ts";
import type { WebAccessSettings } from "./configuration.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const CONFIG_PATH = getWebSearchConfigPath();
const MIN_PARALLEL_API_KEY_LENGTH = 8;
const MIN_USEFUL_CONTENT = 500;
const SEARCH_TIMEOUT_MS = 60_000;

const PLACEHOLDER_API_KEY_DENYLIST = new Set([
	"replace_with_your_parallel_api_key",
	"parallel_api_key",
	"your-key",
	"your-key-here",
	"your-api-key-here",
	"dummy",
	"placeholder",
	"changeme",
	"insert-your-key",
	"insert-your-key-here",
	"api-key",
	"xxx",
]);

interface V1WebSearchResult {
	url: string;
	title?: string | null;
	publish_date?: string | null;
	excerpts?: string[];
}

interface V1ExtractResult {
	url: string;
	title?: string | null;
	publish_date?: string | null;
	excerpts?: string[];
	full_content?: string | null;
}

interface ParallelSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function isPlaceholderApiKey(key: string): boolean {
	const normalized = key.trim();
	return normalized.length < MIN_PARALLEL_API_KEY_LENGTH || PLACEHOLDER_API_KEY_DENYLIST.has(normalized.toLowerCase());
}

function resolveApiKey(settings: Pick<WebAccessSettings, "parallelApiKey">): string | null {
	const envKey = normalizeApiKey(process.env.PARALLEL_API_KEY);
	if (envKey && !isPlaceholderApiKey(envKey)) return envKey;

	const configKey = normalizeApiKey(settings.parallelApiKey);
	if (configKey && !isPlaceholderApiKey(configKey)) return configKey;

	return null;
}

function getApiKey(settings: Pick<WebAccessSettings, "parallelApiKey">): string {
	const key = resolveApiKey(settings);
	if (!key) {
		throw new Error(
			"Parallel API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "parallelApiKey": "your-key" }\n` +
			"  2. Set PARALLEL_API_KEY environment variable\n" +
			"Get a key at https://platform.parallel.ai",
		);
	}
	return key;
}

export function hasParallelApiKey(settings: Pick<WebAccessSettings, "parallelApiKey"> = {}): boolean {
	return !!resolveApiKey(settings);
}

export function isParallelAvailable(settings: Pick<WebAccessSettings, "parallelApiKey"> = {}): boolean {
	return hasParallelApiKey(settings);
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function activityContext(
	url: string,
	body: Record<string, unknown>,
): { type: "api" | "fetch"; query?: string; url?: string } {
	if (typeof body.objective === "string" && body.objective.trim().length > 0) {
		return { type: "api", query: body.objective };
	}

	const searchQueries = body.search_queries;
	if (Array.isArray(searchQueries) && typeof searchQueries[0] === "string") {
		return { type: "api", query: searchQueries[0] };
	}

	const urls = body.urls;
	if (Array.isArray(urls) && typeof urls[0] === "string") {
		return { type: "fetch", url: urls[0] };
	}

	return url.includes("/search") ? { type: "api", query: "Parallel search" } : { type: "fetch", url };
}

function recencyToAfterDate(filter: string): string {
	const now = new Date();
	const offsets: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (!input) return null;
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
		input = parsed.hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function mapDomainFilter(domainFilter: string[] | undefined): { include_domains?: string[]; exclude_domains?: string[] } {
	if (!domainFilter?.length) return {};
	const include_domains: string[] = [];
	const exclude_domains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude_domains : include_domains;
		if (!target.includes(domain)) target.push(domain);
	}
	return {
		...(include_domains.length ? { include_domains } : {}),
		...(exclude_domains.length ? { exclude_domains } : {}),
	};
}

function buildSearchRequestBody(query: string, options: ParallelSearchOptions = {}): Record<string, unknown> {
	const numResults = Math.max(1, Math.min(Math.floor(options.numResults ?? 5), 20));
	const sourcePolicy = {
		...mapDomainFilter(options.domainFilter),
		...(options.recencyFilter ? { after_date: recencyToAfterDate(options.recencyFilter) } : {}),
	};
	return {
		objective: query,
		search_queries: [query],
		advanced_settings: {
			max_results: numResults,
			...(Object.keys(sourcePolicy).length > 0 ? { source_policy: sourcePolicy } : {}),
		},
	};
}

function normalizeExcerpts(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mapSearchResults(results: V1WebSearchResult[] | undefined): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const excerpts = normalizeExcerpts(item.excerpts);
		mapped.push({
			title: item.title || `Source ${i + 1}`,
			url: item.url,
			snippet: excerpts.length > 0 ? excerpts[0].replace(/\s+/g, " ").trim().slice(0, 200) : "",
		});
	}
	return mapped;
}

function buildAnswerFromExcerpts(results: V1WebSearchResult[] | undefined): string {
	if (!Array.isArray(results)) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const excerpts = normalizeExcerpts(item.excerpts);
		if (excerpts.length === 0) continue;
		parts.push(`${excerpts.join(" ")}\nSource: ${item.title || `Source ${i + 1}`} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapInlineContent(results: V1WebSearchResult[] | undefined): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((result) => {
		if (!result?.url) return [];
		const excerpts = normalizeExcerpts(result.excerpts);
		if (excerpts.length === 0) return [];
		return [{ url: result.url, title: result.title || "", content: excerpts.join("\n\n"), error: null }];
	});
}

function resolveExtractContent(result: V1ExtractResult): string {
	const fullContent = typeof result.full_content === "string" ? result.full_content.trim() : "";
	return fullContent.length > 0 ? fullContent : normalizeExcerpts(result.excerpts).join("\n\n");
}

function mapExtractResult(result: V1ExtractResult | undefined | null): ExtractedContent | null {
	if (!result?.url) return null;
	const content = resolveExtractContent(result);
	if (content.length < MIN_USEFUL_CONTENT) return null;
	return {
		url: result.url,
		title: typeof result.title === "string" ? result.title.trim() : "",
		content,
		error: null,
	};
}

function buildExtractRequestBody(url: string, options: ExtractOptions = {}, fullContent = false): Record<string, unknown> {
	const body: Record<string, unknown> = { urls: [url] };
	const prompt = options.prompt?.trim();
	if (prompt) body.objective = prompt;
	if (fullContent) body.advanced_settings = { full_content: true };
	return body;
}

function findExtractResult(results: V1ExtractResult[] | undefined, url: string): V1ExtractResult | undefined {
	if (!Array.isArray(results)) return undefined;
	return results.find(item => item?.url === url) ?? results[0];
}

function hasExtractUrlError(errors: unknown, url: string): boolean {
	if (!Array.isArray(errors)) return false;
	return errors.some((entry) => {
		if (typeof entry === "string") return entry === url;
		return typeof entry === "object" && entry !== null && (entry as { url?: unknown }).url === url;
	});
}

async function fetchAndMapExtractResult(
	url: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	settings: Pick<WebAccessSettings, "parallelApiKey">,
): Promise<{ mapped: ExtractedContent | null; result: V1ExtractResult | undefined }> {
	const data = await parallelFetch(PARALLEL_EXTRACT_URL, body, signal, settings);
	if (hasExtractUrlError(data.errors, url)) return { mapped: null, result: undefined };
	const result = findExtractResult(data.results as V1ExtractResult[] | undefined, url);
	return { mapped: mapExtractResult(result), result };
}

export async function searchWithParallel(query: string, options: ParallelSearchOptions = {}, settings: Pick<WebAccessSettings, "parallelApiKey"> = {}): Promise<SearchResponse> {
	const data = await parallelFetch(PARALLEL_SEARCH_URL, buildSearchRequestBody(query, options), options.signal, settings);
	const results = data.results as V1WebSearchResult[] | undefined;
	const response: SearchResponse = {
		answer: buildAnswerFromExcerpts(results),
		results: mapSearchResults(results),
	};
	if (options.includeContent) {
		const inlineContent = mapInlineContent(results);
		if (inlineContent.length > 0) response.inlineContent = inlineContent;
	}
	return response;
}

export async function extractWithParallel(
	url: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
	settings: Pick<WebAccessSettings, "parallelApiKey"> = {},
): Promise<ExtractedContent | null> {
	const initial = await fetchAndMapExtractResult(url, buildExtractRequestBody(url, options), signal, settings);
	if (initial.mapped) return initial.mapped;
	if (!initial.result || resolveExtractContent(initial.result).length >= MIN_USEFUL_CONTENT) return null;

	const retry = await fetchAndMapExtractResult(url, buildExtractRequestBody(url, options, true), signal, settings);
	return retry.mapped;
}

async function parallelFetch(
	url: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
	settings: Pick<WebAccessSettings, "parallelApiKey">,
): Promise<Record<string, unknown>> {
	const apiKey = getApiKey(settings);
	const activityId = activityMonitor.logStart(activityContext(url, body));
	const operationSignal = requestSignal(signal);
	let response: Response;
	try {
		response = await settleWithAbort(
			() => fetch(url, {
				method: "POST",
				headers: {
					"x-api-key": apiKey,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: operationSignal,
			}),
			operationSignal,
			lateResponse => abandonResponseBody(lateResponse, "Parallel response arrived after cancellation"),
		);
	} catch (err) {
		const message = errorMessage(err);
		if (operationSignal.aborted || message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw err;
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = new TextDecoder().decode(await readResponseBytes(response, operationSignal));
		throw new Error(`Parallel API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	try {
		const text = new TextDecoder().decode(await readResponseBytes(response, operationSignal));
		const data = JSON.parse(text) as Record<string, unknown>;
		activityMonitor.logComplete(activityId, response.status);
		return data;
	} catch (err) {
		activityMonitor.logComplete(activityId, operationSignal.aborted ? 0 : response.status);
		if (operationSignal.aborted) throw err;
		throw new Error(`Parallel API returned invalid JSON: ${errorMessage(err)}`);
	}
}

export function createParallelSearchProvider(settings: Pick<WebAccessSettings, "parallelApiKey">): SearchProviderAdapter<"parallel"> {
	return {
		name: "parallel", label: "Parallel",
		eligibility: () => isParallelAvailable(settings) ? { eligible: true } : { eligible: false, reason: "Parallel API key is not configured." },
		search: ({ query, options }) => searchWithParallel(query, options, settings),
	};
}

export const parallelSearchProvider = createParallelSearchProvider({});
