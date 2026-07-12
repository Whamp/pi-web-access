import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const loaderUrl = pathToFileURL(join(dirname(codingAgentEntry), "core/extensions/loader.js"));
const { createExtensionRuntime, loadExtensionsCached } = await import(loaderUrl.href);
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalBraveKey = process.env.BRAVE_API_KEY;
const originalFetch = globalThis.fetch;
const activeRuntimes = new Set();

function restoreEnvironmentVariable(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test.afterEach(async () => {
	for (const runtime of activeRuntimes) await runtime.shutdown();
	activeRuntimes.clear();
	restoreEnvironmentVariable("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnvironmentVariable("BRAVE_API_KEY", originalBraveKey);
	globalThis.fetch = originalFetch;
});

async function loadRuntime(config = {}) {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-agent-workflow-"));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.env.BRAVE_API_KEY = "brave-test-key";

	const runtime = createExtensionRuntime();
	const notifications = [];
	const sent = [];
	runtime.sendMessage = (message, options) => sent.push({ message, options });
	runtime.appendEntry = () => {};
	runtime.refreshTools = () => {};
	runtime.getActiveTools = () => [];
	runtime.getAllTools = () => [];
	runtime.setActiveTools = () => {};
	runtime.setSessionName = () => {};
	runtime.getSessionName = () => undefined;
	runtime.setLabel = () => {};
	runtime.setModel = async () => false;
	runtime.getThinkingLevel = () => "off";
	runtime.setThinkingLevel = () => {};
	runtime.exec = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

	const loaded = await loadExtensionsCached([extensionPath], configDir, undefined, runtime);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	const context = {
		hasUI: true,
		mode: "interactive",
		cwd: configDir,
		model: undefined,
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false }),
		},
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
		ui: { setWidget() {}, notify(message, level) { notifications.push({ message, level }); } },
	};
	const loadedRuntime = {
		extension,
		context,
		notifications,
		sent,
		async shutdown() {
			for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, context);
			activeRuntimes.delete(loadedRuntime);
		},
	};
	activeRuntimes.add(loadedRuntime);
	return loadedRuntime;
}

function installSearchResponse() {
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return new Response(JSON.stringify({
				web: { results: [{ title: "Article", url: "https://example.com/article", description: "Result" }] },
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};
}

async function executeSearch(runtime, params) {
	const tool = runtime.extension.tools.get("web_search")?.definition;
	assert.ok(tool);
	return tool.execute("search-call", params, undefined, undefined, runtime.context);
}

test("web_search defaults to non-curated execution even when UI is available", async () => {
	installSearchResponse();
	const runtime = await loadRuntime();
	const tool = runtime.extension.tools.get("web_search")?.definition;
	assert.ok(tool);
	assert.equal(Check(tool.parameters, { query: "agent search", workflow: "none" }), true);
	assert.equal(Check(tool.parameters, { query: "agent search", workflow: "auto-summary" }), true);

	const result = await executeSearch(runtime, { query: "agent search", provider: "brave" });
	assert.match(result.content[0].text, /Article/);
	assert.equal(runtime.notifications.length, 0);
});

test("registered schema accepts legacy summary-review without advertising it", async () => {
	const runtime = await loadRuntime();
	const tool = runtime.extension.tools.get("web_search")?.definition;
	assert.ok(tool);

	assert.equal(Check(tool.parameters, { query: "legacy search", workflow: "summary-review" }), true);
	assert.doesNotMatch(JSON.stringify(tool.parameters.properties.workflow), /summary-review/);
});

test("legacy bridged summary-review input executes without curation and returns a compatibility warning", async () => {
	installSearchResponse();
	const runtime = await loadRuntime();
	const result = await executeSearch(runtime, { query: "legacy search", provider: "brave", workflow: "summary-review" });

	assert.match(result.content[0].text, /Compatibility warning:.*summary-review.*non-curated/i);
	assert.match(result.content[0].text, /Article/);
	assert.equal(runtime.notifications.length, 0);
});

test("legacy saved summary-review config executes without curation and returns a compatibility warning", async () => {
	installSearchResponse();
	const runtime = await loadRuntime({ workflow: "summary-review" });
	const result = await executeSearch(runtime, { query: "legacy search", provider: "brave" });

	assert.match(result.content[0].text, /Compatibility warning:.*summary-review.*non-curated/i);
	assert.match(result.content[0].text, /Article/);
	assert.equal(runtime.notifications.length, 0);
});

test("auto-summary completes before web_search returns", async () => {
	installSearchResponse();
	const runtime = await loadRuntime();
	const result = await executeSearch(runtime, { query: "summarized search", provider: "brave", workflow: "auto-summary" });

	assert.equal(result.details.summary.workflow, "auto-summary");
	assert.match(result.content[0].text, /Sources/);
	assert.match(result.content[0].text, /https:\/\/example\.com\/article/);
});

test("/websearch explicitly starts the curator", async () => {
	const runtime = await loadRuntime();
	const command = runtime.extension.commands.get("websearch")?.handler;
	assert.ok(command);

	await command("", runtime.context);
	assert.deepEqual(runtime.notifications[0], { message: "Opening web search curator...", level: "info" });
	await runtime.shutdown();
});
