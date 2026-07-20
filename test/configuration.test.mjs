import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import fc from "fast-check";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createWebAccessConfiguration, WebAccessConfigurationError } from "../configuration.ts";
import { failDirectorySync, replaceFsPromiseMethods } from "./fs-faults.mjs";

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
		openaiSearchModel: "gpt-5.6-luna:xhigh",
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
		allowBrowserCookies: true, chromeProfile: " Profile 2 ", searchModel: "gemini-search",
		openaiSearchModel: " gpt-5.4:low ", summaryModel: "openai/summary",
		workflow: "summary-review", curatorTimeoutSeconds: 600,
		githubClone: { enabled: false, maxRepoSizeMB: 12.5, cloneTimeoutSeconds: 7, clonePath: "/var/tmp/repos" },
		youtube: { enabled: false, preferredModel: "youtube-model" },
		video: { enabled: false, preferredModel: "video-model", maxSizeMB: 25 },
		shortcuts: { curate: "Ctrl+X", activity: "CTRL+Y" },
		ssrf: { allowRanges: [" 198.18.0.0/15 ", "fd00::/8"] },
	}));

	const settings = createWebAccessConfiguration({ sourcePath }).current();
	assert.equal(settings.provider, "brave");
	assert.equal(settings.searchProvider, "exa");
	assert.equal(settings.workflow, "summary-review");
	assert.equal(settings.chromeProfile, "Profile 2");
	assert.equal(settings.openaiSearchModel, "gpt-5.4:low");
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
	["invalid shortcut", JSON.stringify({ shortcuts: { curate: "ctrl+banana" } }), "shortcuts.curate"],
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

test("updating the default provider persists only that change and replaces later settings", async () => {
	const sourcePath = await temporaryConfigPath();
	const original = {
		provider: "brave",
		perplexityApiKey: "credential-value",
		video: { maxSizeMB: 25, futureCodec: { name: "future" } },
		futureTopLevel: [1, { enabled: true }],
	};
	await writeFile(sourcePath, JSON.stringify(original));
	const configuration = createWebAccessConfiguration({ sourcePath, warn: () => {} });
	const inFlight = configuration.current();

	await configuration.update({ provider: "exa" });

	assert.equal(inFlight.provider, "brave");
	assert.notStrictEqual(configuration.current(), inFlight);
	assert.equal(configuration.current().provider, "exa");
	assert.deepEqual(JSON.parse(await readFile(sourcePath, "utf8")), {
		...original,
		provider: "exa",
	});
});

test("updates create missing parents and atomically replace files without changing their permissions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-access-update-"));
	const sourcePath = join(directory, "nested", "web-search.json");
	const configuration = createWebAccessConfiguration({ sourcePath });
	await configuration.update({ provider: "brave" });
	assert.equal((await stat(sourcePath)).mode & 0o777, 0o600);

	await chmod(sourcePath, 0o640);
	const previousInode = (await stat(sourcePath)).ino;
	await configuration.update({ provider: "exa" });
	const replacement = await stat(sourcePath);
	assert.notEqual(replacement.ino, previousInode);
	assert.equal(replacement.mode & 0o777, 0o640);
	assert.deepEqual(await readdir(join(directory, "nested")), ["web-search.json"]);
});

test("a failed write keeps the saved file and current settings unchanged without disclosing credentials", async () => {
	const sourcePath = await temporaryConfigPath();
	await writeFile(sourcePath, JSON.stringify({ provider: "brave", perplexityApiKey: "never-report-this" }));
	const previousFile = await readFile(sourcePath, "utf8");
	const configuration = createWebAccessConfiguration({ sourcePath });
	const previous = configuration.current();
	const parent = dirname(sourcePath);
	await chmod(parent, 0o500);
	try {
		await assert.rejects(configuration.update({ provider: "exa" }), error => {
			assert.match(error.message, /Unable to save Web Access configuration/);
			assert.match(error.message, /previous settings remain active/);
			assert.doesNotMatch(error.message, /never-report-this/);
			return true;
		});
	} finally {
		await chmod(parent, 0o700);
	}
	assert.strictEqual(configuration.current(), previous);
	assert.equal(await readFile(sourcePath, "utf8"), previousFile);
});

test("failed persistence stages retain the previous target bytes and current object", async (context) => {
	const probePath = await temporaryConfigPath();
	await writeFile(probePath, "{}");
	const probe = await import("node:fs/promises").then(({ open }) => open(probePath, "r"));
	const prototype = Object.getPrototypeOf(probe);
	await probe.close();

	for (const [method, stage] of [
		["writeFile", "write its temporary file"],
		["sync", "sync its temporary file"],
		["chmod", "set its file permissions"],
		["close", "close its temporary file"],
	]) {
		await context.test(`rollback after ${method} failure`, async () => {
			const sourcePath = await temporaryConfigPath();
			await writeFile(sourcePath, JSON.stringify({ provider: "brave", geminiApiKey: "never-report-this" }));
			const previousBytes = await readFile(sourcePath, "utf8");
			const configuration = createWebAccessConfiguration({ sourcePath });
			const previous = configuration.current();
			const original = prototype[method];
			const fsPatch = method === "close"
				? replaceFsPromiseMethods({
					open: originalOpen => async (...arguments_) => {
						const handle = await originalOpen(...arguments_);
						const originalClose = handle.close;
						let failed = false;
						handle.close = async () => {
							if (!failed) {
								failed = true;
								throw Object.assign(new Error("close failed"), { code: "EIO" });
							}
							return originalClose.call(handle);
						};
						return handle;
					},
				})
				: undefined;
			if (method !== "close") {
				prototype[method] = async function () {
					throw Object.assign(new Error(`${method} failed`), { code: "EIO" });
				};
			}
			try {
				await assert.rejects(configuration.update({ provider: "exa" }), error => {
					assert.match(error.message, new RegExp(stage));
					assert.doesNotMatch(error.message, /never-report-this/);
					return true;
				});
			} finally {
				prototype[method] = original;
				fsPatch?.restore();
			}
			assert.strictEqual(configuration.current(), previous);
			assert.equal(await readFile(sourcePath, "utf8"), previousBytes);
		});
	}
});

test("a failed parent-directory creation retains the previous current object", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-access-mkdir-failure-"));
	const blockingPath = join(directory, "not-a-directory");
	await writeFile(blockingPath, "blocking file");
	const sourcePath = join(blockingPath, "nested", "web-search.json");
	const configuration = createWebAccessConfiguration({ sourcePath });
	const previous = configuration.current();
	await assert.rejects(configuration.update({ provider: "exa" }), /create its parent directory/);
	assert.strictEqual(configuration.current(), previous);
	assert.equal(await readFile(blockingPath, "utf8"), "blocking file");
});

test("a failed parent-directory sync restores the saved file and current settings", async () => {
	const sourcePath = await temporaryConfigPath();
	await writeFile(sourcePath, JSON.stringify({ provider: "brave" }));
	const previousBytes = await readFile(sourcePath, "utf8");
	const configuration = createWebAccessConfiguration({ sourcePath });
	const previous = configuration.current();
	const restoreDirectorySync = await failDirectorySync(sourcePath);
	try {
		await assert.rejects(configuration.update({ provider: "exa" }), /sync its parent directory.*EIO/);
	} finally {
		restoreDirectorySync();
	}
	assert.strictEqual(configuration.current(), previous);
	assert.equal(await readFile(sourcePath, "utf8"), previousBytes);
	assert.deepEqual(await readdir(dirname(sourcePath)), ["web-search.json"]);
});

test("a failed parent-directory sync removes a newly created configuration file", async () => {
	const sourcePath = await temporaryConfigPath();
	const configuration = createWebAccessConfiguration({ sourcePath });
	const previous = configuration.current();
	const restoreDirectorySync = await failDirectorySync(dirname(sourcePath));
	try {
		await assert.rejects(configuration.update({ provider: "exa" }), /sync its parent directory.*EIO/);
	} finally {
		restoreDirectorySync();
	}
	assert.strictEqual(configuration.current(), previous);
	await assert.rejects(readFile(sourcePath, "utf8"), error => error.code === "ENOENT");
	assert.deepEqual(await readdir(dirname(sourcePath)), []);
});

test("an already-missing new file counts as a successful rollback", async () => {
	const sourcePath = await temporaryConfigPath();
	const configuration = createWebAccessConfiguration({ sourcePath });
	const previous = configuration.current();
	const restoreDirectorySync = await failDirectorySync(dirname(sourcePath));
	const fsPatch = replaceFsPromiseMethods({
		unlink: originalUnlink => async path => {
			if (path === sourcePath) {
				await originalUnlink(path);
				throw Object.assign(new Error("already absent"), { code: "ENOENT" });
			}
			return originalUnlink(path);
		},
	});
	try {
		await assert.rejects(configuration.update({ provider: "exa" }), /sync its parent directory.*EIO/);
	} finally {
		restoreDirectorySync();
		fsPatch.restore();
	}
	assert.strictEqual(configuration.current(), previous);
	await assert.rejects(readFile(sourcePath, "utf8"), error => error.code === "ENOENT");
});

test("a failed rollback keeps committed settings aligned and sanitizes an undeletable sidecar", async () => {
	const sourcePath = await temporaryConfigPath();
	await writeFile(sourcePath, JSON.stringify({ provider: "brave", geminiApiKey: "credential-value" }));
	await chmod(sourcePath, 0o400);
	const configuration = createWebAccessConfiguration({ sourcePath });
	const restoreDirectorySync = await failDirectorySync(sourcePath);
	const originalWarn = console.warn;
	const warnings = [];
	let renameCount = 0;
	const fsPatch = replaceFsPromiseMethods({
		rename: originalRename => async (...arguments_) => {
			renameCount++;
			if (renameCount === 2) throw Object.assign(new Error("rollback rename failed"), { code: "EIO" });
			return originalRename(...arguments_);
		},
		unlink: originalUnlink => async path => {
			if (String(path).endsWith(".rollback")) throw Object.assign(new Error("rollback deletion failed"), { code: "EACCES" });
			return originalUnlink(path);
		},
	});
	const { fsPromises } = fsPatch;
	console.warn = (...arguments_) => warnings.push(arguments_);
	try {
		await configuration.update({ provider: "exa" });
	} finally {
		restoreDirectorySync();
		fsPatch.restore();
		console.warn = originalWarn;
	}
	assert.equal(configuration.current().provider, "exa");
	assert.equal(JSON.parse(await readFile(sourcePath, "utf8")).provider, "exa");
	const entries = await readdir(dirname(sourcePath));
	const rollbackName = entries.find(name => name.endsWith(".rollback"));
	assert.ok(rollbackName);
	const rollbackPath = join(dirname(sourcePath), rollbackName);
	assert.equal(await readFile(rollbackPath, "utf8"), "");
	assert.equal((await stat(rollbackPath)).mode & 0o777, 0o600);
	assert.ok(warnings.some(([, context]) => context?.rollbackPath === rollbackPath));
	await fsPromises.unlink(rollbackPath);
	assert.deepEqual(await readdir(dirname(sourcePath)), ["web-search.json"]);
});

test("a successful save leaves no rollback file when deletion is unavailable", async () => {
	const sourcePath = await temporaryConfigPath();
	await writeFile(sourcePath, JSON.stringify({ provider: "brave", geminiApiKey: "credential-value" }));
	const configuration = createWebAccessConfiguration({ sourcePath });
	const fsPatch = replaceFsPromiseMethods({
		unlink: () => async () => {
			throw Object.assign(new Error("unlink unavailable"), { code: "EACCES" });
		},
	});
	try {
		await configuration.update({ provider: "exa" });
	} finally {
		fsPatch.restore();
	}
	assert.equal(configuration.current().provider, "exa");
	assert.deepEqual(await readdir(dirname(sourcePath)), ["web-search.json"]);
});

test("an unsupported parent-directory sync still completes the saved runtime update", async () => {
	const sourcePath = await temporaryConfigPath();
	await writeFile(sourcePath, JSON.stringify({ provider: "brave" }));
	const configuration = createWebAccessConfiguration({ sourcePath });
	const restoreDirectorySync = await failDirectorySync(sourcePath, { code: "EINVAL", once: false });
	try {
		await configuration.update({ provider: "exa" });
	} finally {
		restoreDirectorySync();
	}
	assert.equal(configuration.current().provider, "exa");
	assert.equal(JSON.parse(await readFile(sourcePath, "utf8")).provider, "exa");
});

test("a failed atomic replacement leaves the prior current settings and target intact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-access-replacement-"));
	const sourcePath = join(directory, "web-search.json");
	const configuration = createWebAccessConfiguration({ sourcePath });
	const previous = configuration.current();
	await mkdir(sourcePath);

	await assert.rejects(configuration.update({ provider: "exa" }), /atomically replace/);
	assert.strictEqual(configuration.current(), previous);
	assert.equal((await stat(sourcePath)).isDirectory(), true);
	assert.deepEqual(await readdir(directory), ["web-search.json"]);
});

const providers = ["auto", "openai", "brave", "parallel", "tavily", "exa", "perplexity", "gemini"];
const workflows = ["none", "auto-summary", "summary-review"];
const knownTopLevel = new Set([
	"provider", "searchProvider", "webSearch", "allowBrowserCookies", "workflow", "curatorTimeoutSeconds",
	"githubClone", "youtube", "video", "shortcuts", "ssrf", "openaiApiKey", "braveApiKey", "exaApiKey",
	"parallelApiKey", "tavilyApiKey", "perplexityApiKey", "geminiApiKey", "geminiBaseUrl", "cloudflareApiKey",
	"chromeProfile", "searchModel", "openaiSearchModel", "summaryModel",
]);
const nestedKnown = {
	webSearch: new Set(["enabled"]),
	githubClone: new Set(["enabled", "maxRepoSizeMB", "cloneTimeoutSeconds", "clonePath"]),
	youtube: new Set(["enabled", "preferredModel"]),
	video: new Set(["enabled", "preferredModel", "maxSizeMB"]),
	shortcuts: new Set(["curate", "activity"]),
	ssrf: new Set(["allowRanges"]),
};
const nonEmptyString = fc.string({ minLength: 1 }).filter(value => value.trim().length > 0);
const shortcutModifier = fc.constantFrom("ctrl", "shift", "alt", "super");
const shortcutBaseKey = fc.constantFrom(
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	..."`-=[]\\;',./!@#$%^&*()_+|~{}:<>?",
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
	"home", "end", "pageUp", "pageDown", "up", "down", "left", "right",
	"f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
);
const shortcutModifiers = fc.uniqueArray(shortcutModifier, { minLength: 1, maxLength: 4 });
const canonicalShortcut = fc.oneof(
	shortcutBaseKey,
	fc.tuple(shortcutModifiers, shortcutBaseKey).map(([modifiers, baseKey]) => `${modifiers.join("+")}+${baseKey}`),
);
const validShortcut = canonicalShortcut.chain(value => fc.constantFrom(value, value.toUpperCase()));
const invalidShortcut = fc.oneof(
	fc.tuple(shortcutModifier, shortcutBaseKey).map(([modifier, baseKey]) => `${modifier}+${modifier}+${baseKey}`),
	shortcutModifiers.map(modifiers => `${modifiers.join("+")}+`),
	fc.tuple(shortcutModifier, shortcutBaseKey.filter(baseKey => baseKey !== "+"))
		.map(([modifier, baseKey]) => `${modifier}++${baseKey}`),
	fc.tuple(shortcutModifiers, fc.stringMatching(/^unknown[a-z]{2,8}$/))
		.map(([modifiers, baseKey]) => `${modifiers.join("+")}+${baseKey}`),
	fc.integer(),
	fc.constant(null),
);
const unknownKey = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,12}$/);
const unknownObject = known => fc.dictionary(unknownKey.filter(key => !known.has(key)), fc.jsonValue(), { maxKeys: 4 });
const validKnownSettings = fc.record({
	provider: fc.constantFrom(...providers),
	searchProvider: fc.constantFrom(...providers),
	webSearch: fc.record({ enabled: fc.boolean() }),
	allowBrowserCookies: fc.boolean(),
	workflow: fc.constantFrom(...workflows),
	curatorTimeoutSeconds: fc.integer({ min: 1, max: 600 }),
	githubClone: fc.record({
		enabled: fc.boolean(),
		maxRepoSizeMB: fc.integer({ min: 1, max: 10000 }),
		cloneTimeoutSeconds: fc.integer({ min: 1, max: 10000 }),
		clonePath: nonEmptyString,
	}),
	youtube: fc.record({ enabled: fc.boolean(), preferredModel: nonEmptyString }),
	video: fc.record({ enabled: fc.boolean(), preferredModel: nonEmptyString, maxSizeMB: fc.integer({ min: 1, max: 10000 }) }),
	shortcuts: fc.record({ curate: validShortcut, activity: validShortcut }),
	ssrf: fc.record({ allowRanges: fc.constantFrom([], ["198.18.0.0/15"], ["fd00::/8"], ["198.18.0.0/15", "fd00::/8"]) }),
	openaiApiKey: nonEmptyString,
	braveApiKey: nonEmptyString,
	exaApiKey: nonEmptyString,
	parallelApiKey: nonEmptyString,
	tavilyApiKey: nonEmptyString,
	perplexityApiKey: nonEmptyString,
	geminiApiKey: nonEmptyString,
	geminiBaseUrl: nonEmptyString,
	cloudflareApiKey: nonEmptyString,
	chromeProfile: nonEmptyString,
	searchModel: nonEmptyString,
	openaiSearchModel: nonEmptyString,
	summaryModel: nonEmptyString,
});
const completeValidSettings = fc.tuple(
	validKnownSettings,
	unknownObject(knownTopLevel),
	...Object.values(nestedKnown).map(unknownObject),
).map(([known, unknownTop, ...unknownNested]) => {
	const raw = { ...unknownTop, ...known };
	for (const [index, parent] of Object.keys(nestedKnown).entries()) {
		raw[parent] = { ...unknownNested[index], ...known[parent] };
	}
	return raw;
});

test("generated complete settings preserve every unrelated known and unknown field through update", async () => {
	await fc.assert(fc.asyncProperty(completeValidSettings, async raw => {
		const sourcePath = await temporaryConfigPath();
		const persistedRaw = JSON.parse(JSON.stringify(raw));
		await writeFile(sourcePath, JSON.stringify(raw));
		const warnings = [];
		const configuration = createWebAccessConfiguration({ sourcePath, warn: message => warnings.push(message) });
		const inFlight = configuration.current();
		await configuration.update({ provider: "exa" });
		assert.strictEqual(inFlight.provider, raw.provider);
		assert.deepEqual(JSON.parse(await readFile(sourcePath, "utf8")), { ...persistedRaw, provider: "exa" });
		assert.ok(warnings.length <= 1);
	}), { numRuns: 60 });
});

test("generated complete valid settings normalize to a stable immutable current value", async () => {
	await fc.assert(fc.asyncProperty(completeValidSettings, async raw => {
		const sourcePath = await temporaryConfigPath();
		await writeFile(sourcePath, JSON.stringify(raw));
		const first = createWebAccessConfiguration({ sourcePath, warn: () => {} }).current();
		const second = createWebAccessConfiguration({ sourcePath, warn: () => {} }).current();
		assert.deepEqual(second, first);
		assert.ok(Object.isFrozen(first) && Object.isFrozen(first.githubClone) && Object.isFrozen(first.ssrf.allowRanges));
	}), { numRuns: 60 });
});

test("generated unknown values at every object level are warned by key and never by value", async () => {
	await fc.assert(fc.asyncProperty(fc.uuid(), async token => {
		const sourcePath = await temporaryConfigPath();
		const secrets = Object.keys(nestedKnown).map((parent, index) => `${token}-${parent}-${index}`);
		const raw = { futureTop: `${token}-top` };
		for (const [index, parent] of Object.keys(nestedKnown).entries()) raw[parent] = { [`future${index}`]: secrets[index] };
		await writeFile(sourcePath, JSON.stringify(raw));
		const warnings = [];
		const configuration = createWebAccessConfiguration({ sourcePath, warn: message => warnings.push(message) });
		await configuration.update({ provider: "brave" });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /futureTop/);
		assert.doesNotMatch(warnings[0], new RegExp(token));
		assert.deepEqual(JSON.parse(await readFile(sourcePath, "utf8")), { ...raw, provider: "brave" });
	}), { numRuns: 30 });
});

const invalidString = fc.oneof(fc.constant(""), fc.stringMatching(/^\s+$/), fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.jsonValue()), fc.dictionary(unknownKey, fc.jsonValue()));
const invalidBoolean = fc.oneof(fc.string(), fc.integer(), fc.constant(null), fc.array(fc.jsonValue()), fc.dictionary(unknownKey, fc.jsonValue()));
const invalidPositiveNumber = fc.oneof(fc.integer({ max: 0 }), fc.string(), fc.boolean(), fc.constant(null), fc.array(fc.jsonValue()), fc.dictionary(unknownKey, fc.jsonValue()));
const invalidProvider = fc.oneof(
	invalidString,
	fc.string().filter(value => value.trim().length > 0 && !providers.includes(value.trim().toLowerCase())),
);
const invalidWorkflow = fc.oneof(
	invalidString,
	fc.string().filter(value => value.trim().length > 0 && !workflows.includes(value.trim().toLowerCase())),
);
const invalidObject = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.jsonValue()));
const invalidFieldArbitraries = [
	["provider", invalidProvider.map(value => ({ provider: value }))],
	["searchProvider", invalidProvider.map(value => ({ searchProvider: value }))],
	["webSearch", invalidObject.map(value => ({ webSearch: value }))],
	["webSearch.enabled", invalidBoolean.map(value => ({ webSearch: { enabled: value } }))],
	["allowBrowserCookies", invalidBoolean.map(value => ({ allowBrowserCookies: value }))],
	["workflow", invalidWorkflow.map(value => ({ workflow: value }))],
	["curatorTimeoutSeconds", fc.oneof(invalidPositiveNumber, fc.integer({ min: 601 })).map(value => ({ curatorTimeoutSeconds: value }))],
	["githubClone", invalidObject.map(value => ({ githubClone: value }))],
	["githubClone.enabled", invalidBoolean.map(value => ({ githubClone: { enabled: value } }))],
	["githubClone.maxRepoSizeMB", invalidPositiveNumber.map(value => ({ githubClone: { maxRepoSizeMB: value } }))],
	["githubClone.cloneTimeoutSeconds", invalidPositiveNumber.map(value => ({ githubClone: { cloneTimeoutSeconds: value } }))],
	["githubClone.clonePath", invalidString.map(value => ({ githubClone: { clonePath: value } }))],
	["youtube", invalidObject.map(value => ({ youtube: value }))],
	["youtube.enabled", invalidBoolean.map(value => ({ youtube: { enabled: value } }))],
	["youtube.preferredModel", invalidString.map(value => ({ youtube: { preferredModel: value } }))],
	["video", invalidObject.map(value => ({ video: value }))],
	["video.enabled", invalidBoolean.map(value => ({ video: { enabled: value } }))],
	["video.preferredModel", invalidString.map(value => ({ video: { preferredModel: value } }))],
	["video.maxSizeMB", invalidPositiveNumber.map(value => ({ video: { maxSizeMB: value } }))],
	["shortcuts", invalidObject.map(value => ({ shortcuts: value }))],
	["shortcuts.curate", invalidShortcut.map(value => ({ shortcuts: { curate: value } }))],
	["shortcuts.activity", invalidShortcut.map(value => ({ shortcuts: { activity: value } }))],
	["ssrf", invalidObject.map(value => ({ ssrf: value }))],
	["ssrf.allowRanges", fc.oneof(
		fc.string(),
		fc.integer(),
		fc.boolean(),
		fc.constant(null),
		fc.dictionary(unknownKey, fc.jsonValue()),
		fc.array(fc.constant("not-a-cidr"), { minLength: 1 }),
	).map(value => ({ ssrf: { allowRanges: value } }))],
	...(["openaiApiKey", "braveApiKey", "exaApiKey", "parallelApiKey", "tavilyApiKey", "perplexityApiKey", "geminiApiKey", "geminiBaseUrl", "cloudflareApiKey", "chromeProfile", "searchModel", "openaiSearchModel", "summaryModel"]
		.map(key => [key, invalidString.map(value => ({ [key]: value }))])),
];
const invalidKnownSetting = fc.oneof(...invalidFieldArbitraries.map(([key, arbitrary]) => arbitrary.map(raw => ({ key, raw }))));

test("arbitrary invalid values for every known field produce deterministic configuration errors", async () => {
	await fc.assert(fc.asyncProperty(invalidKnownSetting, async ({ key, raw }) => {
		const sourcePath = await temporaryConfigPath();
		await writeFile(sourcePath, JSON.stringify(raw));
		let first;
		let second;
		try { createWebAccessConfiguration({ sourcePath }); } catch (error) { first = error; }
		try { createWebAccessConfiguration({ sourcePath }); } catch (error) { second = error; }
		assert.ok(first instanceof WebAccessConfigurationError);
		assert.ok(second instanceof WebAccessConfigurationError);
		assert.equal(first.key, key);
		assert.equal(second.key, key);
		assert.equal(second.message, first.message);
	}), { numRuns: invalidFieldArbitraries.length * 8 });
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
