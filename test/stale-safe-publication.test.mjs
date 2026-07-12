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

async function createRuntime() {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-publication-"));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify({ workflow: "none" }));
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.env.BRAVE_API_KEY = "brave-test-key";

	const runtime = createExtensionRuntime();
	const entries = [];
	runtime.sendMessage = () => {};
	runtime.appendEntry = (customType, data) => entries.push({ customType, data });
	runtime.refreshTools = () => {};
	runtime.getActiveTools = () => [];
	runtime.getAllTools = () => [];
	runtime.setActiveTools = () => {};
	runtime.getCommands = () => [];
	runtime.setSessionName = () => {};
	runtime.getSessionName = () => undefined;
	runtime.setLabel = () => {};
	runtime.setModel = async () => false;
	runtime.getThinkingLevel = () => "off";
	runtime.setThinkingLevel = () => {};

	const loaded = await loadExtensionsCached([extensionPath], configDir, undefined, runtime);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	const context = {
		hasUI: false,
		mode: "print",
		cwd: configDir,
		sessionManager: { getBranch: () => [] },
		ui: { setWidget() {}, notify() {} },
	};
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, context);
	}
	return { extension, runtime, entries, context };
}

function tool(extension, name) {
	const definition = extension.tools.get(name)?.definition;
	assert.ok(definition, `${name} should be registered`);
	return definition;
}

function installSearchResponse() {
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		assert.match(requestUrl, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search/);
		return new Response(JSON.stringify({
			web: { results: [{ title: "Article", url: "https://example.com/article", description: "Stored result" }] },
		}), { status: 200, headers: { "content-type": "application/json" } });
	};
}

test("a successful web search publishes before its record is immediately retrievable", async () => {
	installSearchResponse();
	const runtime = await createRuntime();
	let publishedBeforeRetrieval = false;
	runtime.runtime.appendEntry = (customType, data) => {
		runtime.entries.push({ customType, data });
		const retrieval = tool(runtime.extension, "get_search_content").execute(
			"retrieve-during-publication",
			{ responseId: data.id, queryIndex: 0 },
		);
		publishedBeforeRetrieval = retrieval.then((result) => result.details?.error === "Not found");
	};

	const result = await tool(runtime.extension, "web_search").execute(
		"search",
		{ query: "publication", provider: "brave", workflow: "none" },
		undefined,
		undefined,
		runtime.context,
	);

	assert.equal(await publishedBeforeRetrieval, true, "record must not enter the cache until publication succeeds");
	assert.equal(runtime.entries.length, 1);
	assert.equal(runtime.entries[0].customType, "web-search-results");
	assert.equal(runtime.entries[0].data.id, result.details.searchId);
	const retrieved = await tool(runtime.extension, "get_search_content").execute(
		"retrieve",
		{ responseId: result.details.searchId, queryIndex: 0 },
	);
	assert.equal(retrieved.details.error, undefined);
	assert.match(retrieved.content[0].text, /Article/);
});

test("stale search publication returns session-changed cancellation without an in-memory-only record", async () => {
	installSearchResponse();
	const runtime = await createRuntime();
	let attemptedId;
	runtime.runtime.appendEntry = (_customType, data) => {
		attemptedId = data.id;
		runtime.runtime.invalidate();
		throw new Error("extension ctx is stale");
	};

	const result = await tool(runtime.extension, "web_search").execute(
		"stale-search",
		{ query: "stale publication", provider: "brave", workflow: "none" },
		undefined,
		undefined,
		runtime.context,
	);

	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "session-changed");
	assert.doesNotMatch(result.content[0].text, /extension ctx is stale/i);
	const retrieved = await tool(runtime.extension, "get_search_content").execute(
		"retrieve-stale-search",
		{ responseId: attemptedId, queryIndex: 0 },
	);
	assert.equal(retrieved.details.error, "Not found");
});

test("stale full-content publication uses the same cancellation and cache behavior", async () => {
	const runtime = await createRuntime();
	globalThis.fetch = async () => new Response(
		`Title: Article\nURL Source: https://example.com/article\nMarkdown Content:\n# Article\n${"content ".repeat(80)}`,
		{ status: 200, headers: { "content-type": "text/markdown" } },
	);
	let attemptedId;
	runtime.runtime.appendEntry = (_customType, data) => {
		attemptedId = data.id;
		runtime.runtime.invalidate();
		throw new Error("extension ctx is stale");
	};

	const result = await tool(runtime.extension, "fetch_content").execute(
		"stale-content",
		{ url: "https://example.com/article" },
		undefined,
		undefined,
	);

	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "session-changed");
	assert.doesNotMatch(result.content[0].text, /extension ctx is stale/i);
	const retrieved = await tool(runtime.extension, "get_search_content").execute(
		"retrieve-stale-content",
		{ responseId: attemptedId, urlIndex: 0 },
	);
	assert.equal(retrieved.details.error, "Not found");
});
