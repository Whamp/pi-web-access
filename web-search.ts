import { braveSearchProvider } from "./brave.ts";
import { exaSearchProvider } from "./exa.ts";
import { geminiSearchProvider } from "./gemini-search.ts";
import { openAISearchProvider } from "./openai-search.ts";
import { parallelSearchProvider } from "./parallel.ts";
import { perplexitySearchProvider } from "./perplexity.ts";
import type {
	FullSearchOptions,
	ProviderEligibility,
	ProviderEligibilityByName,
	ResolvedSearchProvider,
	SearchProviders,
	WebSearch,
} from "./search-provider.ts";
import { tavilySearchProvider } from "./tavily.ts";
import { getWebSearchConfigPath } from "./utils.ts";

const AUTO_PROVIDER_ORDER = ["openai", "exa", "brave", "parallel", "tavily", "perplexity", "gemini"] as const;
const CONFIG_PATH = getWebSearchConfigPath();

function shouldTryOpenAIInAuto(options: FullSearchOptions): boolean {
	if (options.recencyFilter) return false;
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && Math.floor(options.numResults) !== 5) {
		return false;
	}
	return true;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function throwIfCallerCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) signal.throwIfAborted();
}

export class ProviderIneligibleError extends Error {
	readonly provider: ResolvedSearchProvider;
	readonly reason: string;

	constructor(provider: ResolvedSearchProvider, label: string, reason: string) {
		super(`${label} search provider is ineligible: ${reason}`);
		this.name = "ProviderIneligibleError";
		this.provider = provider;
		this.reason = reason;
	}
}

export interface AutoSearchFailure {
	provider: ResolvedSearchProvider;
	label: string;
	error: unknown;
}

export class AutoSearchError extends Error {
	readonly failures: readonly AutoSearchFailure[];

	constructor(failures: AutoSearchFailure[]) {
		super(`Auto provider search failed:\n  - ${failures.map((failure) => `${failure.label}: ${errorMessage(failure.error)}`).join("\n  - ")}`);
		this.name = "AutoSearchError";
		this.failures = failures;
	}
}

function noProviderAvailableError(): Error {
	return new Error(
		"No search provider available. Either:\n" +
		"  1. Use /login to sign in with a Codex subscription for OpenAI web search\n" +
		`  2. Set openaiApiKey, braveApiKey, parallelApiKey, tavilyApiKey, perplexityApiKey, exaApiKey, geminiApiKey, or cloudflareApiKey in ${CONFIG_PATH}\n` +
		"  3. Set OPENAI_API_KEY, BRAVE_API_KEY, PARALLEL_API_KEY, TAVILY_API_KEY, EXA_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY, or CLOUDFLARE_API_KEY env vars\n" +
		"  4. Set GOOGLE_GEMINI_BASE_URL with CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
		"  5. Sign into gemini.google.com in a supported Chromium-based browser",
	);
}

export function createWebSearch(providers: SearchProviders): WebSearch {
	return {
		async eligibility(request = {}) {
			const openai = await providers.openai.eligibility(request);
			const exa = await providers.exa.eligibility(request);
			const brave = await providers.brave.eligibility(request);
			const parallel = await providers.parallel.eligibility(request);
			const tavily = await providers.tavily.eligibility(request);
			const perplexity = await providers.perplexity.eligibility(request);
			const gemini = await providers.gemini.eligibility(request);
			const result: ProviderEligibilityByName = {
				openai,
				exa,
				brave,
				parallel,
				tavily,
				perplexity,
				gemini,
			};
			return result;
		},
		async search(query: string, options: FullSearchOptions = {}) {
			throwIfCallerCancelled(options.signal);
			const provider = options.provider ?? "auto";
			if (provider !== "auto") {
				const selected = providers[provider];
				let eligibility: ProviderEligibility;
				try {
					eligibility = await selected.eligibility({ extensionContext: options.extensionContext });
				} catch (error) {
					throwIfCallerCancelled(options.signal);
					throw error;
				}
				throwIfCallerCancelled(options.signal);
				if (!eligibility.eligible) {
					throw new ProviderIneligibleError(provider, selected.label, eligibility.reason);
				}

				try {
					const response = await selected.search({ query, options });
					throwIfCallerCancelled(options.signal);
					return { ...response, provider };
				} catch (error) {
					throwIfCallerCancelled(options.signal);
					throw error;
				}
			}

			const failures: AutoSearchFailure[] = [];
			for (const providerName of AUTO_PROVIDER_ORDER) {
				throwIfCallerCancelled(options.signal);
				if (providerName === "openai" && !shouldTryOpenAIInAuto(options)) continue;
				const candidate = providers[providerName];
				let eligibility: ProviderEligibility;
				try {
					eligibility = await candidate.eligibility({ extensionContext: options.extensionContext });
				} catch (error) {
					throwIfCallerCancelled(options.signal);
					failures.push({ provider: providerName, label: candidate.label, error });
					continue;
				}
				throwIfCallerCancelled(options.signal);
				if (!eligibility.eligible) continue;
				try {
					const response = await candidate.search({ query, options });
					throwIfCallerCancelled(options.signal);
					if (response) return { ...response, provider: providerName };
					failures.push({
						provider: providerName,
						label: candidate.label,
						error: new Error(`${candidate.label} search returned no results.`),
					});
				} catch (error) {
					throwIfCallerCancelled(options.signal);
					failures.push({ provider: providerName, label: candidate.label, error });
				}
			}

			if (failures.length > 0) throw new AutoSearchError(failures);
			throw noProviderAvailableError();
		},
	};
}

export const webSearch = createWebSearch({
	openai: openAISearchProvider,
	exa: exaSearchProvider,
	brave: braveSearchProvider,
	parallel: parallelSearchProvider,
	tavily: tavilySearchProvider,
	perplexity: perplexitySearchProvider,
	gemini: geminiSearchProvider,
});
