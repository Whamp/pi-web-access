import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SearchProvider = "auto" | "openai" | "brave" | "parallel" | "tavily" | "perplexity" | "gemini" | "exa";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchInlineContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: Array<{ data: string; mimeType: string; timestamp: string }>;
	duration?: number;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: SearchInlineContent[];
}

/** Actionable non-terminal diagnostic returned while automatic provider selection continues. */
export interface ProviderWarning {
	provider: ResolvedSearchProvider;
	message: string;
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
	warnings?: readonly ProviderWarning[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

/** Minimal host context required to resolve model credentials for model-backed search providers. */
export type SearchExtensionContext = Pick<ExtensionContext, "modelRegistry">;

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
	extensionContext?: SearchExtensionContext;
}

export type ProviderEligibility =
	| { eligible: true; reason?: never; warning?: never }
	| { eligible: false; reason: string; warning?: ProviderWarning };

export interface SearchProviderRequest {
	query: string;
	options: FullSearchOptions;
}

export interface SearchProviderEligibilityRequest {
	extensionContext?: SearchExtensionContext;
	signal?: AbortSignal;
}

export interface SearchProviderAdapter<Name extends ResolvedSearchProvider = ResolvedSearchProvider> {
	name: Name;
	label: string;
	eligibility: (request: SearchProviderEligibilityRequest) => ProviderEligibility | Promise<ProviderEligibility>;
	search: (request: SearchProviderRequest) => Promise<SearchResponse>;
}

export interface SearchProviders {
	openai: SearchProviderAdapter<"openai">;
	exa: SearchProviderAdapter<"exa">;
	brave: SearchProviderAdapter<"brave">;
	parallel: SearchProviderAdapter<"parallel">;
	tavily: SearchProviderAdapter<"tavily">;
	perplexity: SearchProviderAdapter<"perplexity">;
	gemini: SearchProviderAdapter<"gemini">;
}

export type ProviderEligibilityByName = {
	[name in ResolvedSearchProvider]: ProviderEligibility;
};

export interface WebSearch {
	search: (query: string, options?: FullSearchOptions) => Promise<AttributedSearchResponse>;
	eligibility: (request?: SearchProviderEligibilityRequest) => Promise<ProviderEligibilityByName>;
}
