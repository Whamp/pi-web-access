import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import fc from "fast-check";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createWebAccessConfiguration, WebAccessConfigurationError } from "../configuration.ts";

async function temporaryConfigPath() {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-access-configuration-"));
	return join(directory, "web-search.json");
}

test("a missing configuration file loads documented defaults", async () => {
	const sourcePath = await temporaryConfigPath();
	const configuration = createWebAccessConfiguration({ sourcePath });

	assert.equal(configuration.sourcePath, sourcePath);
	assert.deepEqual(configuration.current(), {
		provider: "auto",
		webSearch: { enabled: true },
		allowBrowserCookies: false,
		searchModel: "gemini-3-flash-preview",
		workflow: "none",
		curatorTimeoutSeconds: 20,
		githubClone: {
			enabled: true,
			maxRepoSizeMB: 350,
			cloneTimeoutSeconds: 30,
			clonePath: "/tmp/pi-github-repos",
		},
		youtube: { enabled: true, preferredModel: "gemini-3-flash-preview" },
		video: { enabled: true, preferredModel: "gemini-3-flash-preview", maxSizeMB: 50 },
		shortcuts: { curate: "ctrl+shift+s", activity: "ctrl+shift+w" },
		ssrf: { allowRanges: [] },
	});
});

test("a complete valid configuration loads all known settings and compatibility values", async () => {
	const sourcePath = await temporaryConfigPath();
	await writeFile(sourcePath, JSON.stringify({
		provider: " BRAVE ", searchProvider: "exa", webSearch: { enabled: false },
		openaiApiKey: "openai-secret", braveApiKey: "brave-secret", exaApiKey: "exa-secret",
		parallelApiKey: "parallel-secret", tavilyApiKey: "tavily-secret", perplexityApiKey: "perplexity-secret",
		geminiApiKey: "gemini-secret", geminiBaseUrl: "https://example.test/gemini/", cloudflareApiKey: "cloudflare-secret",
		allowBrowserCookies: true, chromeProfile: " Profile 2 ", searchModel: "gemini-search", summaryModel: "openai/summary",
		workflow: "summary-review", curatorTimeoutSeconds: 600,
		githubClone: { enabled: false, maxRepoSizeMB: 12.5, cloneTimeoutSeconds: 7, clonePath: "/var/tmp/repos" },
		youtube: { enabled: false, preferredModel: "youtube-model" },
		video: { enabled: false, preferredModel: "video-model", maxSizeMB: 25 },
		shortcuts: { curate: "ctrl+x", activity: "ctrl+y" },
		ssrf: { allowRanges: [" 198.18.0.0/15 ", "fd00::/8"] },
	}));

	const settings = createWebAccessConfiguration({ sourcePath }).current();
	assert.equal(settings.provider, "brave");
	assert.equal(settings.searchProvider, "exa");
	assert.equal(settings.workflow, "summary-review");
	assert.equal(settings.chromeProfile, "Profile 2");
	assert.equal(settings.geminiBaseUrl, "https://example.test/gemini/");
	assert.deepEqual(settings.ssrf.allowRanges, ["198.18.0.0/15", "fd00::/8"]);
	assert.equal(settings.webSearch.enabled, false);
	assert.equal(settings.githubClone.maxRepoSizeMB, 12.5);
	assert.equal(settings.youtube.preferredModel, "youtube-model");
	assert.equal(settings.video.maxSizeMB, 25);
	assert.equal(settings.shortcuts.activity, "ctrl+y");
});

const invalidCases = [
	["malformed JSON", "{", "$"],
	["non-object root", "[]", "$"],
	["known top-level type", JSON.stringify({ provider: 42 }), "provider"],
	["known enum", JSON.stringify({ provider: "unknown" }), "provider"],
	["nested shape", JSON.stringify({ video: [] }), "video"],
	["nested type", JSON.stringify({ video: { enabled: "yes" } }), "video.enabled"],
	["numeric range", JSON.stringify({ curatorTimeoutSeconds: 601 }), "curatorTimeoutSeconds"],
	["invalid SSRF range", JSON.stringify({ ssrf: { allowRanges: ["0.0.0.0/0"] } }), "ssrf.allowRanges"],
];
for (const [label, contents, key] of invalidCases) {
	test(`invalid configuration fails at startup: ${label}`, async () => {
		const sourcePath = await temporaryConfigPath();
		await writeFile(sourcePath, contents);
		assert.throws(() => createWebAccessConfiguration({ sourcePath }), error => {
			assert.ok(error instanceof WebAccessConfigurationError);
			assert.equal(error.sourcePath, sourcePath);
			assert.equal(error.key, key);
			assert.match(error.message, new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.doesNotMatch(error.message, /openai-secret|0\.0\.0\.0\/0/);
			return true;
		});
	});
}

test("unknown fields produce one key-only warning per load", async () => {
	const sourcePath = await temporaryConfigPath();
	await writeFile(sourcePath, JSON.stringify({ futureToken: "do-not-log", video: { futureModel: "also-secret" } }));
	const warnings = [];
	createWebAccessConfiguration({ sourcePath, warn: message => warnings.push(message) });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /futureToken/);
	assert.match(warnings[0], /video\.futureModel/);
	assert.doesNotMatch(warnings[0], /do-not-log|also-secret/);
});

test("current settings are deeply immutable and manual edits are not reloaded", async () => {
	const sourcePath = await temporaryConfigPath();
	await writeFile(sourcePath, JSON.stringify({ provider: "brave", video: { maxSizeMB: 10 } }));
	const configuration = createWebAccessConfiguration({ sourcePath });
	const current = configuration.current();
	assert.throws(() => { current.provider = "exa"; }, TypeError);
	assert.throws(() => { current.video.maxSizeMB = 20; }, TypeError);
	await writeFile(sourcePath, JSON.stringify({ provider: "exa", video: { maxSizeMB: 20 } }));
	assert.strictEqual(configuration.current(), current);
	assert.equal(configuration.current().provider, "brave");
	assert.equal(configuration.current().video.maxSizeMB, 10);
});

test("generated valid settings normalize to a stable current value", async () => {
	await fc.assert(fc.asyncProperty(
		fc.record({
			provider: fc.constantFrom("auto", "openai", "brave", "parallel", "tavily", "exa", "perplexity", "gemini"),
			enabled: fc.boolean(),
			timeout: fc.integer({ min: 1, max: 600 }),
			maxSize: fc.integer({ min: 1, max: 10000 }),
			model: fc.string({ minLength: 1 }).filter(value => value.trim().length > 0),
		}),
		async ({ provider, enabled, timeout, maxSize, model }) => {
			const sourcePath = await temporaryConfigPath();
			await writeFile(sourcePath, JSON.stringify({ provider, webSearch: { enabled }, curatorTimeoutSeconds: timeout, video: { maxSizeMB: maxSize, preferredModel: model } }));
			const first = createWebAccessConfiguration({ sourcePath }).current();
			const second = createWebAccessConfiguration({ sourcePath }).current();
			assert.deepEqual(second, first);
			assert.ok(Object.isFrozen(first) && Object.isFrozen(first.video));
		}
	), { numRuns: 40 });
});

test("generated invalid known values only produce key-specific configuration errors", async () => {
	const cases = [
		{ key: "provider", raw: { provider: "invalid" } },
		{ key: "searchProvider", raw: { searchProvider: false } },
		...(["openaiApiKey", "braveApiKey", "exaApiKey", "parallelApiKey", "tavilyApiKey", "perplexityApiKey", "geminiApiKey", "geminiBaseUrl", "cloudflareApiKey", "chromeProfile", "searchModel", "summaryModel"]
			.map(key => ({ key, raw: { [key]: " " } }))),
		{ key: "webSearch.enabled", raw: { webSearch: { enabled: 1 } } },
		{ key: "allowBrowserCookies", raw: { allowBrowserCookies: "yes" } },
		{ key: "workflow", raw: { workflow: "curator" } },
		{ key: "curatorTimeoutSeconds", raw: { curatorTimeoutSeconds: 0 } },
		{ key: "githubClone.enabled", raw: { githubClone: { enabled: null } } },
		{ key: "githubClone.maxRepoSizeMB", raw: { githubClone: { maxRepoSizeMB: -1 } } },
		{ key: "githubClone.cloneTimeoutSeconds", raw: { githubClone: { cloneTimeoutSeconds: null } } },
		{ key: "githubClone.clonePath", raw: { githubClone: { clonePath: "" } } },
		{ key: "youtube.enabled", raw: { youtube: { enabled: "yes" } } },
		{ key: "youtube.preferredModel", raw: { youtube: { preferredModel: "" } } },
		{ key: "video.enabled", raw: { video: { enabled: 1 } } },
		{ key: "video.preferredModel", raw: { video: { preferredModel: null } } },
		{ key: "video.maxSizeMB", raw: { video: { maxSizeMB: Number.POSITIVE_INFINITY } } },
		{ key: "shortcuts.curate", raw: { shortcuts: { curate: "" } } },
		{ key: "shortcuts.activity", raw: { shortcuts: { activity: false } } },
		{ key: "ssrf.allowRanges", raw: { ssrf: { allowRanges: ["bad-range"] } } },
	];
	await fc.assert(fc.asyncProperty(fc.constantFrom(...cases), async ({ key, raw }) => {
		const sourcePath = await temporaryConfigPath();
		await writeFile(sourcePath, JSON.stringify(raw));
		assert.throws(() => createWebAccessConfiguration({ sourcePath }), error => error instanceof WebAccessConfigurationError && error.key === key);
	}), { numRuns: cases.length * 3 });
});

test("configuration path precedence is agent dir, XDG pi dir, then default Pi dir", () => {
	const original = {
		agent: process.env.PI_CODING_AGENT_DIR,
		xdg: process.env.XDG_CONFIG_HOME,
		home: process.env.HOME,
	};
	try {
		process.env.PI_CODING_AGENT_DIR = "/tmp/agent-config";
		process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
		assert.equal(createWebAccessConfiguration().sourcePath, "/tmp/agent-config/web-search.json");
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(createWebAccessConfiguration().sourcePath, "/tmp/xdg-config/pi/web-search.json");
		delete process.env.XDG_CONFIG_HOME;
		process.env.HOME = "/tmp/default-home";
		assert.equal(createWebAccessConfiguration().sourcePath, "/tmp/default-home/.pi/web-search.json");
	} finally {
		for (const [name, value] of [["PI_CODING_AGENT_DIR", original.agent], ["XDG_CONFIG_HOME", original.xdg], ["HOME", original.home]]) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	}
});
