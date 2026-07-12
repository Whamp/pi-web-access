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

async function createTestFixture() {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-publication-"));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify({ workflow: "none" }));
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.env.BRAVE_API_KEY = "brave-test-key";

	const extensionRuntime = createExtensionRuntime();
	const entries = [];
	extensionRuntime.sendMessage = () => {};
	extensionRuntime.appendEntry = (customType, data) => entries.push({ customType, data });
	extensionRuntime.refreshTools = () => {};
	extensionRuntime.getActiveTools = () => [];
	extensionRuntime.getAllTools = () => [];
	extensionRuntime.setActiveTools = () => {};
	extensionRuntime.getCommands = () => [];
	extensionRuntime.setSessionName = () => {};
	extensionRuntime.getSessionName = () => undefined;
	extensionRuntime.setLabel = () => {};
	extensionRuntime.setModel = async () => false;
	extensionRuntime.getThinkingLevel = () => "off";
	extensionRuntime.setThinkingLevel = () => {};

	const loaded = await loadExtensionsCached([extensionPath], configDir, undefined, extensionRuntime);
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
	return { extension, extensionRuntime, entries, context };
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

function prepareStalePublication(testFixture) {
	let attemptedId;
	testFixture.extensionRuntime.appendEntry = (_customType, data) => {
		attemptedId = data.id;
		testFixture.extensionRuntime.invalidate();
		throw new Error("extension ctx is stale");
	};

	return {
		get attemptedId() {
			assert.ok(attemptedId, "publication should be attempted");
			return attemptedId;
		},
		assertCancelledWithoutCachedRecord(result, retrieved) {
			assert.equal(result.details.cancelled, true);
			assert.equal(result.details.cancelReason, "session-changed");
			assert.doesNotMatch(result.content[0].text, /extension ctx is stale/i);
			assert.equal(retrieved.details.error, "Not found");
		},
	};
}

test("a successful web search publishes before its record is immediately retrievable", async () => {
	installSearchResponse();
	const fixture = await createTestFixture();
	let publishedBeforeRetrieval = false;
	fixture.extensionRuntime.appendEntry = (customType, data) => {
		fixture.entries.push({ customType, data });
		const retrieval = tool(fixture.extension, "get_search_content").execute(
			"retrieve-during-publication",
			{ responseId: data.id, queryIndex: 0 },
		);
		publishedBeforeRetrieval = retrieval.then((result) => result.details?.error === "Not found");
	};

	const result = await tool(fixture.extension, "web_search").execute(
		"search",
		{ query: "publication", provider: "brave", workflow: "none" },
		undefined,
		undefined,
		fixture.context,
	);

	assert.equal(await publishedBeforeRetrieval, true, "record must not enter the cache until publication succeeds");
	assert.equal(fixture.entries.length, 1);
	assert.equal(fixture.entries[0].customType, "web-search-results");
	assert.equal(fixture.entries[0].data.id, result.details.searchId);
	const retrieved = await tool(fixture.extension, "get_search_content").execute(
		"retrieve",
		{ responseId: result.details.searchId, queryIndex: 0 },
	);
	assert.equal(retrieved.details.error, undefined);
	assert.match(retrieved.content[0].text, /Article/);
});

test("stale search publication returns session-changed cancellation without an in-memory-only record", async () => {
	installSearchResponse();
	const fixture = await createTestFixture();
	const stalePublication = prepareStalePublication(fixture);

	const result = await tool(fixture.extension, "web_search").execute(
		"stale-search",
		{ query: "stale publication", provider: "brave", workflow: "none" },
		undefined,
		undefined,
		fixture.context,
	);

	const retrieved = await tool(fixture.extension, "get_search_content").execute(
		"retrieve-stale-search",
		{ responseId: stalePublication.attemptedId, queryIndex: 0 },
	);
	stalePublication.assertCancelledWithoutCachedRecord(result, retrieved);
});

test("stale full-content publication uses the same cancellation and cache behavior", async () => {
	const fixture = await createTestFixture();
	globalThis.fetch = async () => new Response(
		`Title: Article\nURL Source: https://example.com/article\nMarkdown Content:\n# Article\n${"content ".repeat(80)}`,
		{ status: 200, headers: { "content-type": "text/markdown" } },
	);
	const stalePublication = prepareStalePublication(fixture);

	const result = await tool(fixture.extension, "fetch_content").execute(
		"stale-content",
		{ url: "https://example.com/article" },
		undefined,
		undefined,
	);

	const retrieved = await tool(fixture.extension, "get_search_content").execute(
		"retrieve-stale-content",
		{ responseId: stalePublication.attemptedId, urlIndex: 0 },
	);
	stalePublication.assertCancelledWithoutCachedRecord(result, retrieved);
});
