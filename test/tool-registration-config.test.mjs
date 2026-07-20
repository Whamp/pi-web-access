import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const loaderUrl = pathToFileURL(join(dirname(codingAgentEntry), "core/extensions/loader.js"));
const { createExtensionRuntime, loadExtensionsCached } = await import(loaderUrl.href);
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function loadRegisteredExtension(contents) {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-registration-"));
	if (contents !== undefined) await writeFile(join(configDir, "web-search.json"), contents);
	process.env.PI_CODING_AGENT_DIR = configDir;
	const runtime = createExtensionRuntime();
	const loaded = await loadExtensionsCached([extensionPath], configDir, undefined, runtime);
	return { loaded };
}

test.afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

test("webSearch.enabled false omits only the registered web_search tool", async () => {
	const { loaded } = await loadRegisteredExtension(JSON.stringify({ webSearch: { enabled: false } }));
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	assert.equal(extension.tools.has("web_search"), false);
	assert.equal(extension.tools.has("fetch_content"), true);
	assert.equal(extension.tools.has("get_search_content"), true);
});

test("missing configuration registers web_search with default shortcuts", async () => {
	const { loaded } = await loadRegisteredExtension(undefined);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	assert.ok(extension.tools.has("web_search"));
	assert.ok(extension.shortcuts.has("ctrl+shift+s"));
	assert.ok(extension.shortcuts.has("ctrl+shift+w"));
});

test("custom shortcuts are registered from the startup settings", async () => {
	const { loaded } = await loadRegisteredExtension(JSON.stringify({
		shortcuts: { curate: "super+alt+shift+ctrl+pageUp", activity: "ctrl++" },
	}));
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	assert.ok(extension.shortcuts.has("super+alt+shift+ctrl+pageUp"));
	assert.ok(extension.shortcuts.has("ctrl++"));
	assert.equal(extension.shortcuts.has("ctrl+shift+s"), false);
});

test("mixed-case shortcuts are normalized and registered", async () => {
	const { loaded } = await loadRegisteredExtension(JSON.stringify({
		shortcuts: { curate: "Ctrl+Shift+S", activity: "SUPER+ALT+W" },
	}));

	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	assert.ok(extension.shortcuts.has("ctrl+shift+s"));
	assert.ok(extension.shortcuts.has("super+alt+w"));
});

test("invalid shortcut configuration stops extension registration", async () => {
	const { loaded } = await loadRegisteredExtension(JSON.stringify({ shortcuts: { activity: "ctrl+ctrl+w" } }));
	assert.equal(loaded.extensions.length, 0);
	assert.equal(loaded.errors.length, 1);
	assert.match(loaded.errors[0].error, /shortcuts\.activity must be a valid Pi key identifier/);
	assert.match(loaded.errors[0].error, /web-search\.json/);
});

test("invalid configuration stops extension registration", async () => {
	const { loaded } = await loadRegisteredExtension(JSON.stringify({ webSearch: { enabled: "no" } }));
	assert.equal(loaded.extensions.length, 0);
	assert.equal(loaded.errors.length, 1);
	assert.match(loaded.errors[0].error, /webSearch\.enabled must be a boolean/);
	assert.match(loaded.errors[0].error, /web-search\.json/);
});
