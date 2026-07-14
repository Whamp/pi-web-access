import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const loaderUrl = pathToFileURL(join(dirname(codingAgentEntry), "core/extensions/loader.js"));
const { createExtensionRuntime, loadExtensionsCached } = await import(loaderUrl.href);
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const nativeFetch = globalThis.fetch;

async function loadRegisteredTools(branch = [], options = {}) {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-search-result-"));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify({ ssrf: { allowRanges: ["127.0.0.0/8"] } }));
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.env.EXA_API_KEY = "exa-test-key";
	process.env.BRAVE_API_KEY = "brave-test-key";

	const runtime = createExtensionRuntime();
	const entries = [];
	runtime.appendEntry = (customType, data) => entries.push({ customType, data });
	runtime.sendMessage = () => {};
	runtime.exec = async () => ({ code: 0, stdout: "", stderr: "" });
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
		hasUI: options.hasUI ?? false,
		mode: "print",
		cwd: configDir,
		model: undefined,
		modelRegistry: {
			find: () => undefined,
			getAvailable: () => [],
			getApiKeyAndHeaders: async () => ({ ok: false }),
		},
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => branch },
		ui: { setWidget() {}, notify() {} },
	};
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, context);
	}
	return {
		context,
		entries,
		getSearchContent: extension.tools.get("get_search_content")?.definition,
		webSearch: extension.tools.get("web_search")?.definition,
	};
}

function mockExaSearch() {
	globalThis.fetch = async (url, options) => {
		const requested = String(url);
		const { query } = JSON.parse(options.body);
		if (requested === "https://api.exa.ai/answer") {
			return new Response(JSON.stringify({
				answer: `Full answer for ${query}`,
				citations: [{ title: `Source for ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, text: `Evidence for ${query}` }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (requested === "https://api.exa.ai/search") {
			return new Response(JSON.stringify({ results: [{
				title: `Source for ${query}`,
				url: `https://example.com/${encodeURIComponent(query)}`,
				text: `Complete source content for ${query}`,
				highlights: [`Full answer for ${query}`],
			}] }), { status: 200, headers: { "content-type": "application/json" } });
		}
		return nativeFetch(url, options);
	};
}

async function search(tools, params) {
	return tools.webSearch.execute("search-call", { provider: "exa", workflow: "none", ...params }, undefined, undefined, tools.context);
}

const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function renderText(component) {
	return component.render(160).join("\n").trimEnd();
}

test("a registered single-query web search exposes searchResultId and opens with resultId alone", async () => {
	const tools = await loadRegisteredTools();
	mockExaSearch();

	const searched = await search(tools, { query: "stored search protocol" });

	assert.equal(typeof searched.details.searchResultId, "string");
	assert.equal(searched.details.contentResultId, null);
	assert.deepEqual(Object.keys(searched.details).sort(), [
		"contentErrors",
		"contentReady",
		"contentResultId",
		"includeContent",
		"queries",
		"queryCount",
		"searchResultId",
		"successfulQueries",
		"totalResults",
	]);
	assert.doesNotMatch(searched.content[0].text, /get_search_content/);

	const retrieved = await tools.getSearchContent.execute("retrieve-call", {
		resultId: searched.details.searchResultId,
	});
	assert.match(retrieved.content[0].text, /Full answer for stored search protocol/);
	assert.equal(retrieved.details.resultId, searched.details.searchResultId);
	assert.equal(retrieved.details.query, "stored search protocol");
});

test("a registered multi-query result lists choices and supports query selectors with corrective errors", async () => {
	const tools = await loadRegisteredTools();
	mockExaSearch();
	const searched = await search(tools, { queries: ["first query", "second query"] });
	const resultId = searched.details.searchResultId;

	const choices = await tools.getSearchContent.execute("choices", { resultId });
	assert.match(choices.content[0].text, new RegExp(`resultId "${resultId}"`));
	assert.match(choices.content[0].text, /0: "first query"/);
	assert.match(choices.content[0].text, /1: "second query"/);
	assert.deepEqual(choices.details.queries, ["first query", "second query"]);

	const byQuery = await tools.getSearchContent.execute("by-query", { resultId, query: "second query" });
	assert.match(byQuery.content[0].text, /Full answer for second query/);
	assert.equal(byQuery.details.resultId, resultId);

	const byIndex = await tools.getSearchContent.execute("by-index", { resultId, queryIndex: 0 });
	assert.match(byIndex.content[0].text, /Full answer for first query/);

	for (const invalid of [
		await tools.getSearchContent.execute("unknown-query", { resultId, query: "missing query" }),
		await tools.getSearchContent.execute("bad-index", { resultId, queryIndex: 9 }),
	]) {
		assert.match(invalid.content[0].text, new RegExp(`resultId "${resultId}"`));
		assert.match(invalid.content[0].text, /first query/);
		assert.match(invalid.content[0].text, /second query/);
		assert.equal(invalid.details.resultId, resultId);
	}
});

test("an automatic summary gives distinct retrieval calls for omitted search results and source content", async () => {
	const tools = await loadRegisteredTools();
	mockExaSearch();
	const summarized = await tools.webSearch.execute(
		"auto-summary",
		{ query: "condensed query", provider: "exa", workflow: "auto-summary", includeContent: true },
		undefined,
		undefined,
		tools.context,
	);
	const { searchResultId, contentResultId } = summarized.details;

	assert.equal(typeof searchResultId, "string");
	assert.equal(typeof contentResultId, "string");
	assert.notEqual(searchResultId, contentResultId);
	assert.match(summarized.content[0].text, new RegExp(`get_search_content\\(\\{ resultId: "${searchResultId}" \\}\\)`));
	assert.match(summarized.content[0].text, new RegExp(`get_search_content\\(\\{ resultId: "${contentResultId}" \\}\\)`));

	const searchResult = await tools.getSearchContent.execute("summary-search", { resultId: searchResultId });
	assert.match(searchResult.content[0].text, /Full answer for condensed query/);
	const contentResult = await tools.getSearchContent.execute("summary-content", { resultId: contentResultId });
	assert.match(contentResult.content[0].text, /Complete source content for condensed query/);
});

test("legacy summary-review keeps stored result retrieval available without opening the curator", async () => {
	const tools = await loadRegisteredTools([], { hasUI: true });
	mockExaSearch();
	const result = await tools.webSearch.execute(
		"legacy-summary-review",
		{ query: "legacy workflow query", provider: "exa", workflow: "summary-review" },
		undefined,
		undefined,
		tools.context,
	);

	assert.match(result.content[0].text, /Compatibility warning/);
	assert.equal(result.details.curated, undefined);
	const retrieved = await tools.getSearchContent.execute("legacy-retrieve", {
		resultId: result.details.searchResultId,
	});
	assert.match(retrieved.content[0].text, /Full answer for legacy workflow query/);
});

test("restored Web search records retain single-query retrieval parity", async () => {
	const original = await loadRegisteredTools();
	mockExaSearch();
	const searched = await search(original, { query: "restored query" });
	const branch = original.entries.map(({ customType, data }) => ({ type: "custom", customType, data }));

	const restored = await loadRegisteredTools(branch);
	const retrieved = await restored.getSearchContent.execute("restored", { resultId: searched.details.searchResultId });
	assert.match(retrieved.content[0].text, /Full answer for restored query/);
	assert.equal(retrieved.details.resultId, searched.details.searchResultId);
});

test("stored search failures and unknown references use resultId vocabulary", async () => {
	const tools = await loadRegisteredTools();
	globalThis.fetch = async (url) => {
		if (String(url).startsWith("https://api.exa.ai/")) return new Response("provider unavailable", { status: 503 });
		return nativeFetch(url);
	};
	const searched = await search(tools, { query: "failed query" });
	const failed = await tools.getSearchContent.execute("failed", { resultId: searched.details.searchResultId });
	assert.match(failed.content[0].text, new RegExp(`resultId "${searched.details.searchResultId}"`));
	assert.match(failed.content[0].text, /provider unavailable/);
	assert.equal(failed.details.resultId, searched.details.searchResultId);

	const missing = await tools.getSearchContent.execute("missing", { resultId: "missing-search-result" });
	assert.match(missing.content[0].text, /resultId "missing-search-result"/);
	assert.equal(missing.details.resultId, "missing-search-result");
});

test("registered renderers show semantic search and result references", async () => {
	const tools = await loadRegisteredTools();
	mockExaSearch();
	const searched = await search(tools, { queries: ["render first", "render second"] });
	const webSearchText = renderText(tools.webSearch.renderResult(searched, { expanded: true, isPartial: false }, plainTheme));
	assert.deepEqual(
		webSearchText.split("\n").map((line) => line.trim()).filter((line) => /[A-Za-z]+Id:/.test(line)),
		[`searchResultId: ${searched.details.searchResultId}`],
	);

	const choices = await tools.getSearchContent.execute("render-choices", { resultId: searched.details.searchResultId });
	const choicesText = renderText(tools.getSearchContent.renderResult(choices, { expanded: true }, plainTheme));
	assert.match(choicesText, new RegExp(`resultId: ${searched.details.searchResultId}`));
	assert.match(choicesText, /2 queries/);
});
