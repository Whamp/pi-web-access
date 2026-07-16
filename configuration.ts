import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { WebAccessConfigurationError } from "./errors.ts";
import { logWarn } from "./logger.ts";
import type { SearchProvider } from "./search-provider.ts";
import { validateSsrfAllowRanges } from "./ssrf-protection.ts";

type WorkflowSetting = "none" | "auto-summary" | "summary-review";

/** Shared settings for YouTube and local-video retrieval. */
export interface MediaSettings {
	readonly youtube: Readonly<{ enabled: boolean; preferredModel: string }>;
	readonly video: Readonly<{ enabled: boolean; preferredModel: string; maxSizeMB: number }>;
}

/** Immutable, startup-validated settings captured by each Web Access operation. */
export interface WebAccessSettings {
	readonly provider: SearchProvider;
	readonly webSearch: Readonly<{ enabled: boolean }>;
	readonly allowBrowserCookies: boolean;
	readonly workflow: WorkflowSetting;
	readonly curatorTimeoutSeconds: number;
	readonly githubClone: Readonly<{ enabled: boolean; maxRepoSizeMB: number; cloneTimeoutSeconds: number; clonePath: string }>;
	readonly youtube: MediaSettings["youtube"];
	readonly video: MediaSettings["video"];
	readonly shortcuts: Readonly<{ curate: string; activity: string }>;
	readonly ssrf: Readonly<{ allowRanges: readonly string[] }>;
	readonly openaiApiKey?: string;
	readonly braveApiKey?: string;
	readonly exaApiKey?: string;
	readonly parallelApiKey?: string;
	readonly tavilyApiKey?: string;
	readonly perplexityApiKey?: string;
	readonly geminiApiKey?: string;
	readonly geminiBaseUrl?: string;
	readonly cloudflareApiKey?: string;
	readonly chromeProfile?: string;
	readonly searchProvider?: SearchProvider;
	readonly searchModel: string;
	readonly summaryModel?: string;
}

/** Owns the current immutable settings value and save-before-swap updates. */
export interface WebAccessConfiguration {
	readonly sourcePath: string;
	current(): Readonly<WebAccessSettings>;
	/** Persists the one setting Search Curator currently changes. */
	update(updates: Readonly<Pick<WebAccessSettings, "provider">>): Promise<void>;
}

/** Construction options for isolated configuration loading and warning delivery. */
export interface WebAccessConfigurationOptions {
	readonly sourcePath?: string;
	readonly warn?: (message: string) => void;
}

const PROVIDERS: readonly SearchProvider[] = ["auto", "openai", "brave", "parallel", "tavily", "exa", "perplexity", "gemini"];
const STRING_KEYS = [
	"openaiApiKey", "braveApiKey", "exaApiKey", "parallelApiKey", "tavilyApiKey", "perplexityApiKey",
	"geminiApiKey", "geminiBaseUrl", "cloudflareApiKey", "chromeProfile", "searchModel", "summaryModel",
] as const;
const KNOWN_KEYS = new Set([
	"provider", "searchProvider", "webSearch", "allowBrowserCookies", "workflow", "curatorTimeoutSeconds",
	"githubClone", "youtube", "video", "shortcuts", "ssrf", ...STRING_KEYS,
]);
const NESTED_KEYS: Record<string, ReadonlySet<string>> = {
	webSearch: new Set(["enabled"]),
	githubClone: new Set(["enabled", "maxRepoSizeMB", "cloneTimeoutSeconds", "clonePath"]),
	youtube: new Set(["enabled", "preferredModel"]),
	video: new Set(["enabled", "preferredModel", "maxSizeMB"]),
	shortcuts: new Set(["curate", "activity"]),
	ssrf: new Set(["allowRanges"]),
};

/** Documented media defaults used by direct extraction callers. */
export const DEFAULT_MEDIA_SETTINGS: Readonly<MediaSettings> = Object.freeze({
	youtube: Object.freeze({ enabled: true, preferredModel: "gemini-3-flash-preview" }),
	video: Object.freeze({ enabled: true, preferredModel: "gemini-3-flash-preview", maxSizeMB: 50 }),
});

/** Documented defaults applied to every omitted Web Access setting. */
export const DEFAULT_WEB_ACCESS_SETTINGS: Readonly<WebAccessSettings> = freezeSettings({
	provider: "auto",
	webSearch: { enabled: true },
	allowBrowserCookies: false,
	searchModel: "gemini-3-flash-preview",
	workflow: "none",
	curatorTimeoutSeconds: 20,
	githubClone: { enabled: true, maxRepoSizeMB: 350, cloneTimeoutSeconds: 30, clonePath: "/tmp/pi-github-repos" },
	youtube: DEFAULT_MEDIA_SETTINGS.youtube,
	video: DEFAULT_MEDIA_SETTINGS.video,
	shortcuts: { curate: "ctrl+shift+s", activity: "ctrl+shift+w" },
	ssrf: { allowRanges: [] },
});

interface JsonObject {
	[key: string]: unknown;
}

function fail(path: string, key: string, expectation: string): never {
	throw new WebAccessConfigurationError(path, key, expectation);
}

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectAt(value: unknown, path: string, key: string): JsonObject {
	if (!isJsonObject(value)) fail(path, key, "must be an object");
	return value;
}

function booleanAt(value: unknown, path: string, key: string): boolean {
	if (typeof value !== "boolean") fail(path, key, "must be a boolean");
	return value;
}

function stringAt(value: unknown, path: string, key: string): string {
	if (typeof value !== "string" || value.trim().length === 0) fail(path, key, "must be a non-empty string");
	return value.trim();
}

function positiveNumberAt(value: unknown, path: string, key: string, maximum = Number.MAX_VALUE): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
		fail(path, key, `must be a finite number greater than 0 and at most ${maximum}`);
	}
	return value;
}

function providerAt(value: unknown, path: string, key: string): SearchProvider {
	const normalized = stringAt(value, path, key).toLowerCase();
	switch (normalized) {
		case "auto": return "auto";
		case "openai": return "openai";
		case "brave": return "brave";
		case "parallel": return "parallel";
		case "tavily": return "tavily";
		case "exa": return "exa";
		case "perplexity": return "perplexity";
		case "gemini": return "gemini";
		default: return fail(path, key, `must be one of ${PROVIDERS.join(", ")}`);
	}
}

function workflowAt(value: unknown, path: string): WorkflowSetting {
	const normalized = stringAt(value, path, "workflow").toLowerCase();
	switch (normalized) {
		case "none": return "none";
		case "auto-summary": return "auto-summary";
		case "summary-review": return "summary-review";
		default: return fail(path, "workflow", "must be one of none, auto-summary, summary-review");
	}
}

function unknownKeys(raw: JsonObject): string[] {
	const unknown = Object.keys(raw).filter(key => !KNOWN_KEYS.has(key));
	for (const [parent, known] of Object.entries(NESTED_KEYS)) {
		const value = raw[parent];
		if (isJsonObject(value)) {
			for (const key of Object.keys(value)) {
				if (!known.has(key)) unknown.push(`${parent}.${key}`);
			}
		}
	}
	return unknown.sort();
}

function normalizeAllowRanges(value: unknown, path: string): readonly string[] {
	if (!Array.isArray(value)) fail(path, "ssrf.allowRanges", "must be an array of CIDR strings");
	const ranges = value.map((entry, index) => stringAt(entry, path, `ssrf.allowRanges[${index}]`));
	try {
		validateSsrfAllowRanges(ranges);
	} catch {
		fail(path, "ssrf.allowRanges", "must contain valid CIDR ranges excluding /0");
	}
	return ranges;
}

function normalize(raw: JsonObject, path: string): Readonly<WebAccessSettings> {
	const webSearch = raw.webSearch === undefined ? undefined : objectAt(raw.webSearch, path, "webSearch");
	const githubClone = raw.githubClone === undefined ? undefined : objectAt(raw.githubClone, path, "githubClone");
	const youtube = raw.youtube === undefined ? undefined : objectAt(raw.youtube, path, "youtube");
	const video = raw.video === undefined ? undefined : objectAt(raw.video, path, "video");
	const shortcuts = raw.shortcuts === undefined ? undefined : objectAt(raw.shortcuts, path, "shortcuts");
	const ssrf = raw.ssrf === undefined ? undefined : objectAt(raw.ssrf, path, "ssrf");
	const defaults = DEFAULT_WEB_ACCESS_SETTINGS;
	const settings: WebAccessSettings = {
		provider: raw.provider === undefined ? defaults.provider : providerAt(raw.provider, path, "provider"),
		...(raw.searchProvider === undefined ? {} : { searchProvider: providerAt(raw.searchProvider, path, "searchProvider") }),
		webSearch: {
			enabled: webSearch?.enabled === undefined ? defaults.webSearch.enabled : booleanAt(webSearch.enabled, path, "webSearch.enabled"),
		},
		allowBrowserCookies: raw.allowBrowserCookies === undefined
			? defaults.allowBrowserCookies
			: booleanAt(raw.allowBrowserCookies, path, "allowBrowserCookies"),
		workflow: raw.workflow === undefined ? defaults.workflow : workflowAt(raw.workflow, path),
		curatorTimeoutSeconds: raw.curatorTimeoutSeconds === undefined
			? defaults.curatorTimeoutSeconds
			: positiveNumberAt(raw.curatorTimeoutSeconds, path, "curatorTimeoutSeconds", 600),
		githubClone: {
			enabled: githubClone?.enabled === undefined ? defaults.githubClone.enabled : booleanAt(githubClone.enabled, path, "githubClone.enabled"),
			maxRepoSizeMB: githubClone?.maxRepoSizeMB === undefined ? defaults.githubClone.maxRepoSizeMB : positiveNumberAt(githubClone.maxRepoSizeMB, path, "githubClone.maxRepoSizeMB"),
			cloneTimeoutSeconds: githubClone?.cloneTimeoutSeconds === undefined ? defaults.githubClone.cloneTimeoutSeconds : positiveNumberAt(githubClone.cloneTimeoutSeconds, path, "githubClone.cloneTimeoutSeconds"),
			clonePath: githubClone?.clonePath === undefined ? defaults.githubClone.clonePath : stringAt(githubClone.clonePath, path, "githubClone.clonePath"),
		},
		youtube: {
			enabled: youtube?.enabled === undefined ? defaults.youtube.enabled : booleanAt(youtube.enabled, path, "youtube.enabled"),
			preferredModel: youtube?.preferredModel === undefined ? defaults.youtube.preferredModel : stringAt(youtube.preferredModel, path, "youtube.preferredModel"),
		},
		video: {
			enabled: video?.enabled === undefined ? defaults.video.enabled : booleanAt(video.enabled, path, "video.enabled"),
			preferredModel: video?.preferredModel === undefined ? defaults.video.preferredModel : stringAt(video.preferredModel, path, "video.preferredModel"),
			maxSizeMB: video?.maxSizeMB === undefined ? defaults.video.maxSizeMB : positiveNumberAt(video.maxSizeMB, path, "video.maxSizeMB"),
		},
		shortcuts: {
			curate: shortcuts?.curate === undefined ? defaults.shortcuts.curate : stringAt(shortcuts.curate, path, "shortcuts.curate"),
			activity: shortcuts?.activity === undefined ? defaults.shortcuts.activity : stringAt(shortcuts.activity, path, "shortcuts.activity"),
		},
		ssrf: {
			allowRanges: ssrf?.allowRanges === undefined ? defaults.ssrf.allowRanges : normalizeAllowRanges(ssrf.allowRanges, path),
		},
		...(raw.openaiApiKey === undefined ? {} : { openaiApiKey: stringAt(raw.openaiApiKey, path, "openaiApiKey") }),
		...(raw.braveApiKey === undefined ? {} : { braveApiKey: stringAt(raw.braveApiKey, path, "braveApiKey") }),
		...(raw.exaApiKey === undefined ? {} : { exaApiKey: stringAt(raw.exaApiKey, path, "exaApiKey") }),
		...(raw.parallelApiKey === undefined ? {} : { parallelApiKey: stringAt(raw.parallelApiKey, path, "parallelApiKey") }),
		...(raw.tavilyApiKey === undefined ? {} : { tavilyApiKey: stringAt(raw.tavilyApiKey, path, "tavilyApiKey") }),
		...(raw.perplexityApiKey === undefined ? {} : { perplexityApiKey: stringAt(raw.perplexityApiKey, path, "perplexityApiKey") }),
		...(raw.geminiApiKey === undefined ? {} : { geminiApiKey: stringAt(raw.geminiApiKey, path, "geminiApiKey") }),
		...(raw.geminiBaseUrl === undefined ? {} : { geminiBaseUrl: stringAt(raw.geminiBaseUrl, path, "geminiBaseUrl") }),
		...(raw.cloudflareApiKey === undefined ? {} : { cloudflareApiKey: stringAt(raw.cloudflareApiKey, path, "cloudflareApiKey") }),
		...(raw.chromeProfile === undefined ? {} : { chromeProfile: stringAt(raw.chromeProfile, path, "chromeProfile") }),
		searchModel: raw.searchModel === undefined ? defaults.searchModel : stringAt(raw.searchModel, path, "searchModel"),
		...(raw.summaryModel === undefined ? {} : { summaryModel: stringAt(raw.summaryModel, path, "summaryModel") }),
	};
	return freezeSettings(settings);
}

function freezeSettings(settings: WebAccessSettings): Readonly<WebAccessSettings> {
	Object.freeze(settings.webSearch);
	Object.freeze(settings.githubClone);
	Object.freeze(settings.youtube);
	Object.freeze(settings.video);
	Object.freeze(settings.shortcuts);
	Object.freeze(settings.ssrf.allowRanges);
	Object.freeze(settings.ssrf);
	return Object.freeze(settings);
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EISDIR" || error.code === "EBADF";
}

let productionConfiguration: WebAccessConfiguration | undefined;

/**
 * Returns the process-wide configuration, loading it on first use.
 * Invalid persistent settings throw a key-specific configuration error.
 */
export function getWebAccessConfiguration(): WebAccessConfiguration {
	productionConfiguration ??= createWebAccessConfiguration();
	return productionConfiguration;
}

function resolveSourcePath(): string {
	const directory = process.env.PI_CODING_AGENT_DIR
		?? (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "pi") : join(homedir(), ".pi"));
	return join(directory, "web-search.json");
}

function emitUnknownKeyWarning(options: WebAccessConfigurationOptions, sourcePath: string, unknown: readonly string[]): void {
	const message = `Unknown Web Access configuration keys in ${sourcePath}: ${unknown.join(", ")}`;
	if (options.warn) {
		options.warn(message);
	} else {
		logWarn("Unknown Web Access configuration keys", { sourcePath, keys: unknown });
	}
}

/**
 * Loads one validated immutable configuration from disk.
 * Missing files use defaults; malformed or invalid known fields throw before callers receive a value.
 */
export function createWebAccessConfiguration(options: WebAccessConfigurationOptions = {}): WebAccessConfiguration {
	const sourcePath = options.sourcePath ?? resolveSourcePath();
	let raw: JsonObject = {};
	if (existsSync(sourcePath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
		} catch {
			fail(sourcePath, "$", "must contain valid JSON");
		}
		raw = objectAt(parsed, sourcePath, "$");
	}
	let settings = normalize(raw, sourcePath);
	const unknown = unknownKeys(raw);
	if (unknown.length > 0) emitUnknownKeyWarning(options, sourcePath, unknown);

	async function persistUpdate(updates: Readonly<Pick<WebAccessSettings, "provider">>): Promise<void> {
		const nextRaw = structuredClone(raw);
		nextRaw.provider = providerAt(updates.provider, sourcePath, "provider");
		const nextSettings = normalize(nextRaw, sourcePath);
		const serialized = `${JSON.stringify(nextRaw, null, 2)}\n`;
		const parent = dirname(sourcePath);
		const temporaryPath = join(parent, `.${basename(sourcePath)}.${randomUUID()}.tmp`);
		let stage = "create its parent directory";
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(parent, { recursive: true });
			let mode = 0o600;
			stage = "inspect existing file permissions";
			try {
				mode = (await stat(sourcePath)).mode & 0o777;
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
			}
			stage = "write its temporary file";
			handle = await open(temporaryPath, "wx", mode);
			await handle.writeFile(serialized, "utf8");
			stage = "sync its temporary file";
			await handle.sync();
			stage = "set its file permissions";
			await handle.chmod(mode);
			stage = "close its temporary file";
			await handle.close();
			handle = undefined;
			stage = "atomically replace the configuration file";
			await rename(temporaryPath, sourcePath);
			stage = "open its parent directory for durability";
			directoryHandle = await open(parent, "r");
			stage = "sync its parent directory for durability";
			try {
				await directoryHandle.sync();
			} catch (error) {
				if (!isUnsupportedDirectorySync(error)) throw error;
			}
			stage = "close its parent directory after durability";
			await directoryHandle.close();
			directoryHandle = undefined;
		} catch (error) {
			await handle?.close().catch(() => {});
			await directoryHandle?.close().catch(() => {});
			await unlink(temporaryPath).catch(() => {});
			const cause = error instanceof Error && "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
			throw new Error(`Unable to save Web Access configuration at ${sourcePath}: failed to ${stage}${cause}; previous settings remain active.`);
		}
		raw = nextRaw;
		settings = nextSettings;
	}

	let updateQueue = Promise.resolve();
	function update(updates: Readonly<Pick<WebAccessSettings, "provider">>): Promise<void> {
		const result = updateQueue.then(() => persistUpdate(updates));
		updateQueue = result.catch(() => {});
		return result;
	}

	return { sourcePath, current: () => settings, update };
}

export { WebAccessConfigurationError } from "./errors.ts";
