import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtractedContent } from "./extract.ts";
import type { SearchResult } from "./search-provider.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;
const rejectedStoredResultPublications = new WeakSet<object>();

export interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
}

export interface StoredSearchResultData {
	id: string;
	type: "search";
	timestamp: number;
	queries: QueryResultData[];
}

export interface StoredContentResultData {
	id: string;
	type: "fetch";
	timestamp: number;
	urls: ExtractedContent[];
}

export type StoredResultData = StoredSearchResultData | StoredContentResultData;

interface StoredResultPublicationData {
	type: "stored-result-publication";
	records: [StoredSearchResultData, StoredContentResultData];
}

type StoredResultPublisher = Pick<ExtensionAPI, "appendEntry">;

interface ContentSelector {
	url?: string;
	urlIndex?: number;
}

interface ContentRetrievalResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		error?: string;
		resultId?: string;
		urls?: string[];
		url?: string;
		title?: string;
		contentLength?: number;
	};
}

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function contentRetrievalCall(contentResultId: string): string {
	return `get_search_content({ resultId: "${contentResultId}" })`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
	return typeof value === "string" || value === null;
}

function isSearchResult(value: unknown): value is SearchResult {
	return isRecord(value)
		&& typeof value.title === "string"
		&& typeof value.url === "string"
		&& typeof value.snippet === "string";
}

function isQueryResultData(value: unknown): value is QueryResultData {
	return isRecord(value)
		&& typeof value.query === "string"
		&& typeof value.answer === "string"
		&& Array.isArray(value.results)
		&& value.results.every(isSearchResult)
		&& isNullableString(value.error)
		&& (value.provider === undefined || typeof value.provider === "string");
}

function isExtractedContent(value: unknown): value is ExtractedContent {
	return isRecord(value)
		&& typeof value.url === "string"
		&& typeof value.title === "string"
		&& typeof value.content === "string"
		&& isNullableString(value.error);
}

function isValidStoredData(data: unknown): data is StoredResultData {
	if (!isRecord(data)) return false;
	if (typeof data.id !== "string" || data.id.length === 0) return false;
	if (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)) return false;
	if (data.type === "search") {
		return Array.isArray(data.queries) && data.queries.every(isQueryResultData);
	}
	if (data.type === "fetch") {
		return Array.isArray(data.urls) && data.urls.every(isExtractedContent);
	}
	return false;
}

function isValidStoredResultPublication(data: unknown): data is StoredResultPublicationData {
	if (!isRecord(data) || data.type !== "stored-result-publication") return false;
	if (!Array.isArray(data.records) || data.records.length !== 2) return false;
	const [searchResult, contentResult] = data.records;
	return isValidStoredData(searchResult)
		&& searchResult.type === "search"
		&& isValidStoredData(contentResult)
		&& contentResult.type === "fetch"
		&& searchResult.id !== contentResult.id
		&& searchResult.timestamp === contentResult.timestamp;
}

function withoutMedia(urls: ExtractedContent[]): ExtractedContent[] {
	return urls.map(({ thumbnail: _thumbnail, frames: _frames, ...url }) => url);
}

export function createStoredResultStore() {
	const storedResults = new Map<string, StoredResultData>();

	function publishStoredResults(
		publisher: StoredResultPublisher,
		data: StoredResultData | StoredResultPublicationData,
	): void {
		try {
			publisher.appendEntry("web-search-results", data);
		} catch (error) {
			rejectedStoredResultPublications.add(data);
			throw error;
		}
	}

	function createSearchResult(
		queries: QueryResultData[],
		publisher: StoredResultPublisher,
	): string {
		const id = generateId();
		const data: StoredResultData = {
			id,
			type: "search",
			timestamp: Date.now(),
			queries,
		};
		publishStoredResults(publisher, data);
		storedResults.set(id, data);
		return id;
	}

	function createContentResult(
		urls: ExtractedContent[],
		publisher: StoredResultPublisher,
		contentResultId = generateId(),
	): string {
		const data: StoredContentResultData = {
			id: contentResultId,
			type: "fetch",
			timestamp: Date.now(),
			urls: withoutMedia(urls),
		};
		publishStoredResults(publisher, data);
		storedResults.set(contentResultId, data);
		return contentResultId;
	}

	function createSearchWithContentResults(
		queries: QueryResultData[],
		urls: ExtractedContent[],
		publisher: StoredResultPublisher,
	): { searchResultId: string; contentResultId: string } {
		const timestamp = Date.now();
		const searchResult: StoredSearchResultData = {
			id: generateId(),
			type: "search",
			timestamp,
			queries,
		};
		const contentResult: StoredContentResultData = {
			id: generateId(),
			type: "fetch",
			timestamp,
			urls: withoutMedia(urls),
		};
		const publication: StoredResultPublicationData = {
			type: "stored-result-publication",
			records: [searchResult, contentResult],
		};
		publishStoredResults(publisher, publication);
		storedResults.set(searchResult.id, searchResult);
		storedResults.set(contentResult.id, contentResult);
		return {
			searchResultId: searchResult.id,
			contentResultId: contentResult.id,
		};
	}

	function retrieveContentResult(
		resultId: string,
		selector: ContentSelector,
	): ContentRetrievalResult | null {
		const data = storedResults.get(resultId);
		if (!data) {
			return {
				content: [{ type: "text", text: `Error: No stored result for resultId "${resultId}".` }],
				details: { error: "Not found", resultId },
			};
		}
		if (data.type !== "fetch" || !data.urls) return null;

		const urls = data.urls.map((item) => item.url);
		const available = urls.map((item, index) => `${index}: ${item}`).join("\n  ");
		let urlData: ExtractedContent | undefined;

		if (selector.url !== undefined) {
			urlData = data.urls.find((item) => item.url === selector.url);
			if (!urlData) {
				return {
					content: [{ type: "text", text: `URL "${selector.url}" not found for resultId "${resultId}". Available:\n  ${available}` }],
					details: { error: "URL not found", resultId, urls },
				};
			}
		} else if (selector.urlIndex !== undefined) {
			urlData = data.urls[selector.urlIndex];
			if (!urlData) {
				return {
					content: [{ type: "text", text: `urlIndex ${selector.urlIndex} is out of range for resultId "${resultId}". Available:\n  ${available}` }],
					details: { error: "Index out of range", resultId, urls },
				};
			}
		} else if (data.urls.length === 1) {
			urlData = data.urls[0];
		} else {
			return {
				content: [{ type: "text", text: `Choose a URL with url or urlIndex for resultId "${resultId}". Available:\n  ${available}` }],
				details: { resultId, urls },
			};
		}

		if (urlData.error) {
			return {
				content: [{ type: "text", text: `Stored content failed for resultId "${resultId}" at ${urlData.url}: ${urlData.error}` }],
				details: { error: urlData.error, resultId, url: urlData.url },
			};
		}

		return {
			content: [{ type: "text", text: `# ${urlData.title}\n\n${urlData.content}` }],
			details: {
				resultId,
				url: urlData.url,
				title: urlData.title,
				contentLength: urlData.content.length,
			},
		};
	}

	function restoreFromSession(ctx: ExtensionContext): void {
		storedResults.clear();
		const now = Date.now();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "web-search-results") continue;
			const data = entry.data;
			if (isRecord(data) && rejectedStoredResultPublications.has(data)) continue;
			if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
				storedResults.set(data.id, data);
				continue;
			}
			if (isValidStoredResultPublication(data)) {
				const publicationIsFresh = now - data.records[0].timestamp < CACHE_TTL_MS;
				if (publicationIsFresh) {
					for (const record of data.records) storedResults.set(record.id, record);
				}
			}
		}
	}

	return {
		clear: () => storedResults.clear(),
		createContentResult,
		createSearchResult,
		createSearchWithContentResults,
		delete: (id: string) => storedResults.delete(id),
		get: (id: string) => storedResults.get(id) ?? null,
		getAll: () => Array.from(storedResults.values()),
		reserveContentResultId: generateId,
		restoreFromSession,
		retrieveContentResult,
	};
}
