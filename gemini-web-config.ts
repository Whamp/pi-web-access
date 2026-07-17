import { getWebAccessConfiguration, type WebAccessSettings } from "./configuration.ts";

type GeminiWebSettings = Pick<WebAccessSettings, "allowBrowserCookies" | "chromeProfile">;

export function normalizeChromeProfile(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

export function getChromeProfileFromConfig(settings?: GeminiWebSettings): string | undefined {
	return (settings ?? getWebAccessConfiguration().current()).chromeProfile;
}

export function isBrowserCookieAccessAllowed(settings?: GeminiWebSettings): boolean {
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") {
		return true;
	}
	return (settings ?? getWebAccessConfiguration().current()).allowBrowserCookies;
}
