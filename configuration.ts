import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { validateSsrfAllowRanges } from "./ssrf-protection.ts";

export type SearchProviderSetting = "auto" | "openai" | "brave" | "parallel" | "tavily" | "exa" | "perplexity" | "gemini";
export type WorkflowSetting = "none" | "auto-summary" | "summary-review";

export interface MediaSettings {
	readonly youtube: Readonly<{ enabled: boolean; preferredModel: string }>;
	readonly video: Readonly<{ enabled: boolean; preferredModel: string; maxSizeMB: number }>;
}

export interface WebAccessSettings {
	readonly provider: SearchProviderSetting;
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
	readonly searchProvider?: SearchProviderSetting;
	readonly searchModel: string;
	readonly summaryModel?: string;
}

export class WebAccessConfigurationError extends Error {
	readonly sourcePath: string;
	readonly key: string;

	constructor(sourcePath: string, key: string, expectation: string) {
		super(`Invalid Web Access configuration at ${sourcePath}: ${key} ${expectation}`);
		this.name = "WebAccessConfigurationError";
		this.sourcePath = sourcePath;
		this.key = key;
	}
}

export interface WebAccessConfiguration {
	readonly sourcePath: string;
	current(): Readonly<WebAccessSettings>;
	/** Persist the one setting Search Curator currently changes without exposing storage operations to callers. */
	update(updates: Readonly<Pick<WebAccessSettings, "provider">>): Promise<void>;
}

export interface WebAccessConfigurationOptions {
	readonly sourcePath?: string;
	readonly warn?: (message: string) => void;
}

const PROVIDERS = ["auto", "openai", "brave", "parallel", "tavily", "exa", "perplexity", "gemini"] as const;
const WORKFLOWS = ["none", "auto-summary", "summary-review"] as const;
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

// Direct extraction callers need documented media defaults without reading the
// configuration file. Production operations receive a startup-validated snapshot.
export const DEFAULT_MEDIA_SETTINGS: Readonly<MediaSettings> = Object.freeze({
	youtube: Object.freeze({ enabled: true, preferredModel: "gemini-3-flash-preview" }),
	video: Object.freeze({ enabled: true, preferredModel: "gemini-3-flash-preview", maxSizeMB: 50 }),
});

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

type MutableSettings = { -readonly [K in keyof WebAccessSettings]: WebAccessSettings[K] };
type JsonObject = Record<string, unknown>;

function fail(path: string, key: string, expectation: string): never {
	throw new WebAccessConfigurationError(path, key, expectation);
}

function objectAt(value: unknown, path: string, key: string): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, key, "must be an object");
	return value as JsonObject;
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

function providerAt(value: unknown, path: string, key: string): SearchProviderSetting {
	const normalized = stringAt(value, path, key).toLowerCase();
	if (!PROVIDERS.includes(normalized as SearchProviderSetting)) fail(path, key, `must be one of ${PROVIDERS.join(", ")}`);
	return normalized as SearchProviderSetting;
}

function workflowAt(value: unknown, path: string): WorkflowSetting {
	const normalized = stringAt(value, path, "workflow").toLowerCase();
	if (!WORKFLOWS.includes(normalized as WorkflowSetting)) fail(path, "workflow", `must be one of ${WORKFLOWS.join(", ")}`);
	return normalized as WorkflowSetting;
}

function unknownKeys(raw: JsonObject): string[] {
	const unknown = Object.keys(raw).filter(key => !KNOWN_KEYS.has(key));
	for (const [parent, known] of Object.entries(NESTED_KEYS)) {
		const value = raw[parent];
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			for (const key of Object.keys(value)) if (!known.has(key)) unknown.push(`${parent}.${key}`);
		}
	}
	return unknown.sort();
}

function normalize(raw: JsonObject, path: string): Readonly<WebAccessSettings> {
	const settings = structuredClone(DEFAULT_WEB_ACCESS_SETTINGS) as MutableSettings;
	if (raw.provider !== undefined) settings.provider = providerAt(raw.provider, path, "provider");
	if (raw.searchProvider !== undefined) settings.searchProvider = providerAt(raw.searchProvider, path, "searchProvider");
	if (raw.allowBrowserCookies !== undefined) settings.allowBrowserCookies = booleanAt(raw.allowBrowserCookies, path, "allowBrowserCookies");
	if (raw.workflow !== undefined) settings.workflow = workflowAt(raw.workflow, path);
	if (raw.curatorTimeoutSeconds !== undefined) settings.curatorTimeoutSeconds = positiveNumberAt(raw.curatorTimeoutSeconds, path, "curatorTimeoutSeconds", 600);
	for (const key of STRING_KEYS) {
		if (raw[key] !== undefined) settings[key] = stringAt(raw[key], path, key);
	}

	if (raw.webSearch !== undefined) {
		const value = objectAt(raw.webSearch, path, "webSearch");
		if (value.enabled !== undefined) settings.webSearch = { enabled: booleanAt(value.enabled, path, "webSearch.enabled") };
	}
	if (raw.githubClone !== undefined) {
		const value = objectAt(raw.githubClone, path, "githubClone");
		settings.githubClone = {
			enabled: value.enabled === undefined ? settings.githubClone.enabled : booleanAt(value.enabled, path, "githubClone.enabled"),
			maxRepoSizeMB: value.maxRepoSizeMB === undefined ? settings.githubClone.maxRepoSizeMB : positiveNumberAt(value.maxRepoSizeMB, path, "githubClone.maxRepoSizeMB"),
			cloneTimeoutSeconds: value.cloneTimeoutSeconds === undefined ? settings.githubClone.cloneTimeoutSeconds : positiveNumberAt(value.cloneTimeoutSeconds, path, "githubClone.cloneTimeoutSeconds"),
			clonePath: value.clonePath === undefined ? settings.githubClone.clonePath : stringAt(value.clonePath, path, "githubClone.clonePath"),
		};
	}
	if (raw.youtube !== undefined) {
		const value = objectAt(raw.youtube, path, "youtube");
		settings.youtube = {
			enabled: value.enabled === undefined ? settings.youtube.enabled : booleanAt(value.enabled, path, "youtube.enabled"),
			preferredModel: value.preferredModel === undefined ? settings.youtube.preferredModel : stringAt(value.preferredModel, path, "youtube.preferredModel"),
		};
	}
	if (raw.video !== undefined) {
		const value = objectAt(raw.video, path, "video");
		settings.video = {
			enabled: value.enabled === undefined ? settings.video.enabled : booleanAt(value.enabled, path, "video.enabled"),
			preferredModel: value.preferredModel === undefined ? settings.video.preferredModel : stringAt(value.preferredModel, path, "video.preferredModel"),
			maxSizeMB: value.maxSizeMB === undefined ? settings.video.maxSizeMB : positiveNumberAt(value.maxSizeMB, path, "video.maxSizeMB"),
		};
	}
	if (raw.shortcuts !== undefined) {
		const value = objectAt(raw.shortcuts, path, "shortcuts");
		settings.shortcuts = {
			curate: value.curate === undefined ? settings.shortcuts.curate : stringAt(value.curate, path, "shortcuts.curate"),
			activity: value.activity === undefined ? settings.shortcuts.activity : stringAt(value.activity, path, "shortcuts.activity"),
		};
	}
	if (raw.ssrf !== undefined) {
		const value = objectAt(raw.ssrf, path, "ssrf");
		if (value.allowRanges !== undefined) {
			if (!Array.isArray(value.allowRanges)) fail(path, "ssrf.allowRanges", "must be an array of CIDR strings");
			const ranges = value.allowRanges.map((entry, index) => stringAt(entry, path, `ssrf.allowRanges[${index}]`));
			try {
				validateSsrfAllowRanges(ranges);
			} catch {
				fail(path, "ssrf.allowRanges", "must contain valid CIDR ranges excluding /0");
			}
			settings.ssrf = { allowRanges: ranges };
		}
	}
	return freezeSettings(settings as WebAccessSettings);
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

let productionConfiguration: WebAccessConfiguration | undefined;

/**
 * Returns the one process-wide production configuration, loading it on first use.
 * Invalid persistent settings throw a key-specific WebAccessConfigurationError.
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
	if (unknown.length > 0) (options.warn ?? console.warn)(`Unknown Web Access configuration keys in ${sourcePath}: ${unknown.join(", ")}`);

	async function persistUpdate(updates: Readonly<Pick<WebAccessSettings, "provider">>): Promise<void> {
		const nextRaw = structuredClone(raw);
		nextRaw.provider = providerAt(updates.provider, sourcePath, "provider");
		const nextSettings = normalize(nextRaw, sourcePath);
		const serialized = `${JSON.stringify(nextRaw, null, 2)}\n`;
		const parent = dirname(sourcePath);
		const temporaryPath = join(parent, `.${basename(sourcePath)}.${randomUUID()}.tmp`);
		let stage = "create its parent directory";
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(parent, { recursive: true });
			let mode = 0o600;
			stage = "inspect existing file permissions";
			try {
				mode = (await stat(sourcePath)).mode & 0o777;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
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
		} catch (error) {
			await handle?.close().catch(() => {});
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
