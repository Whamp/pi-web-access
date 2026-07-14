import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtractedContent } from "./extract.ts";
import type { SearchResult } from "./search-provider.ts";

const CACHE_TTL_MS = 60 * 60 * 1000;

export interface QueryResultData {
	query: string;
	answer: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
}

export interface StoredResultData {
	id: string;
	type: "search" | "fetch";
	timestamp: number;
	queries?: QueryResultData[];
	urls?: ExtractedContent[];
}

const storedResults = new Map<string, StoredResultData>();

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredResultData): void {
	storedResults.set(id, data);
}

type ContentPublisher = Pick<ExtensionAPI, "appendEntry">;

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

function publishContentResult(
	contentResultId: string,
	urls: ExtractedContent[],
	publisher: ContentPublisher,
): void {
	const storedUrls = urls.map(({ thumbnail: _thumbnail, frames: _frames, ...url }) => url);
	const data: StoredResultData = {
		id: contentResultId,
		type: "fetch",
		timestamp: Date.now(),
		urls: storedUrls,
	};
	storeResult(contentResultId, data);
	publisher.appendEntry("web-search-results", data);
}

export function createContentResult(
	urls: ExtractedContent[],
	publisher: ContentPublisher,
	contentResultId = generateId(),
): string {
	publishContentResult(contentResultId, urls, publisher);
	return contentResultId;
}

export function reserveContentResultId(): string {
	return generateId();
}

export function contentRetrievalCall(contentResultId: string): string {
	return `get_search_content({ resultId: "${contentResultId}" })`;
}

export function retrieveContentResult(
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

export function getResult(id: string): StoredResultData | null {
	return storedResults.get(id) ?? null;
}

export function getAllResults(): StoredResultData[] {
	return Array.from(storedResults.values());
}

export function deleteResult(id: string): boolean {
	return storedResults.delete(id);
}

export function clearResults(): void {
	storedResults.clear();
}

function isValidStoredData(data: unknown): data is StoredResultData {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id) return false;
	if (d.type !== "search" && d.type !== "fetch") return false;
	if (typeof d.timestamp !== "number") return false;
	if (d.type === "search" && !Array.isArray(d.queries)) return false;
	if (d.type === "fetch" && !Array.isArray(d.urls)) return false;
	return true;
}

export function restoreFromSession(ctx: ExtensionContext): void {
	storedResults.clear();
	const now = Date.now();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "web-search-results") {
			const data = entry.data;
			if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
				storedResults.set(data.id, data);
			}
		}
	}
}
