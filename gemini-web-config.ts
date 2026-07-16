import { getWebAccessConfiguration } from "./configuration.ts";

export function normalizeChromeProfile(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

export function getChromeProfileFromConfig(): string | undefined {
	return getWebAccessConfiguration().current().chromeProfile;
}

export function isBrowserCookieAccessAllowed(): boolean {
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") {
		return true;
	}
	return getWebAccessConfiguration().current().allowBrowserCookies;
}
