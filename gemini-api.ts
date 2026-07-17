import { getWebAccessConfiguration, type WebAccessSettings } from "./configuration.ts";
import { fetchOwnedResponse, readResponseText } from "./response-body.ts";

const DEFAULT_API_HOST = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";
export const API_BASE = `${DEFAULT_API_HOST}/${API_VERSION}`;
export const DEFAULT_MODEL = "gemini-3-flash-preview";

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/\/+$/, "");
	return normalized.length > 0 ? normalized : null;
}

type GeminiApiSettings = Pick<WebAccessSettings, "geminiApiKey" | "geminiBaseUrl" | "cloudflareApiKey">;

function currentSettings(settings?: GeminiApiSettings): GeminiApiSettings {
	return settings ?? getWebAccessConfiguration().current();
}

function isCloudflareGateway(settings?: GeminiApiSettings): boolean {
	return getApiHost(settings).includes("gateway.ai.cloudflare.com");
}

/** Resolves the Gemini API key, preserving environment-variable precedence. */
export function getApiKey(settings?: GeminiApiSettings): string | null {
	return normalizeApiKey(process.env.GEMINI_API_KEY) ?? normalizeApiKey(currentSettings(settings).geminiApiKey);
}

/** Resolves the configured Gemini API host without its API version suffix. */
export function getApiHost(settings?: GeminiApiSettings): string {
	return (
		normalizeBaseUrl(process.env.GOOGLE_GEMINI_BASE_URL) ??
		normalizeBaseUrl(currentSettings(settings).geminiBaseUrl) ??
		DEFAULT_API_HOST
	);
}

/** Resolves the versioned Gemini generate-content API base URL. */
export function getVersionedApiBase(settings?: GeminiApiSettings): string {
	return `${getApiHost(settings)}/${API_VERSION}`;
}

/** Builds direct-Google key authentication, omitting it for gateways. */
export function buildKeyParam(apiKey: string | null, settings?: GeminiApiSettings): string {
	if (!apiKey || isCloudflareGateway(settings)) return "";
	return `?key=${apiKey}`;
}

/** Resolves the Cloudflare gateway key, preserving environment precedence. */
export function getCloudflareApiKey(settings?: GeminiApiSettings): string | null {
	return normalizeApiKey(process.env.CLOUDFLARE_API_KEY) ?? normalizeApiKey(currentSettings(settings).cloudflareApiKey);
}

/** Reports whether a Cloudflare Gemini gateway has complete authentication. */
export function isGatewayConfigured(settings?: GeminiApiSettings): boolean {
	return isCloudflareGateway(settings) && getCloudflareApiKey(settings) !== null;
}

/** Builds gateway authorization headers for the captured settings value. */
export function buildAuthHeaders(settings?: GeminiApiSettings): Record<string, string> {
	if (!isCloudflareGateway(settings)) return {};
	const cloudflareApiKey = getCloudflareApiKey(settings);
	return cloudflareApiKey ? { "cf-aig-authorization": `Bearer ${cloudflareApiKey}` } : {};
}

/** Reports Gemini API or gateway eligibility for the captured settings value. */
export function isGeminiApiAvailable(settings?: GeminiApiSettings): boolean {
	return getApiKey(settings) !== null || isGatewayConfigured(settings);
}

/** Controls Gemini video generation requests. */
export interface GeminiApiOptions {
	model?: string;
	mimeType?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** Queries Gemini for video understanding and throws on unavailable or empty responses. */
export async function queryGeminiApiWithVideo(
	prompt: string,
	videoUri: string,
	options: GeminiApiOptions = {},
	settings?: GeminiApiSettings,
): Promise<string> {
	const apiKey = getApiKey(settings);
	if (!apiKey && !isGatewayConfigured(settings)) {
		throw new Error(
			"Gemini API not configured. Either:\n" +
			`  1. Set GEMINI_API_KEY in ${getWebAccessConfiguration().sourcePath}\n` +
			"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing"
		);
	}

	const model = options.model ?? DEFAULT_MODEL;
	const signal = withTimeout(options.signal, options.timeoutMs ?? 120000);
	const url = `${getVersionedApiBase(settings)}/models/${model}:generateContent${buildKeyParam(apiKey, settings)}`;

	const fileData: Record<string, string> = { fileUri: videoUri };
	if (options.mimeType) fileData.mimeType = options.mimeType;

	const body = {
		contents: [
			{
				role: "user",
				parts: [
					{ fileData },
					{ text: prompt },
				],
			},
		],
	};

	const res = await fetchOwnedResponse(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...buildAuthHeaders(settings) },
		body: JSON.stringify(body),
	}, signal);

	if (!res.ok) {
		const errorText = await readResponseText(res, signal);
		throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
	}

	const data = JSON.parse(await readResponseText(res, signal)) as GenerateContentResponse;
	const text = data.candidates?.[0]?.content?.parts
		?.map((p) => p.text)
		.filter(Boolean)
		.join("\n");

	if (!text) throw new Error("Gemini API returned empty response");
	return text;
}

interface GenerateContentResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
	}>;
}
