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

async function loadRegisteredTools(branch = [], options = {}) {
	const configDir = options.configDir ?? await mkdtemp(join(tmpdir(), "pi-web-access-content-result-"));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify({ ssrf: { allowRanges: ["127.0.0.0/8"] } }));
	process.env.PI_CODING_AGENT_DIR = configDir;

	const runtime = createExtensionRuntime();
	const entries = [];
	runtime.appendEntry = (customType, data) => {
		options.appendEntry?.(customType, data);
		entries.push({ customType, data });
	};
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
		sessionManager: { getBranch: () => branch },
		ui: { setWidget() {}, notify() {} },
	};
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, context);
	}

	return {
		entries,
		fetchContent: extension.tools.get("fetch_content")?.definition,
		getSearchContent: extension.tools.get("get_search_content")?.definition,
	};
}

function mockJinaPages(pages) {
	globalThis.fetch = async (url) => {
		const requested = String(url);
		const sourceUrl = requested.replace("https://r.jina.ai/", "");
		const page = pages[sourceUrl];
		if (!page) throw new Error(`Unexpected fetch: ${requested}`);
		return new Response(
			`Title: ${page.title}\nURL Source: ${sourceUrl}\nMarkdown Content:\n${page.content}`,
			{ status: 200, headers: { "content-type": "text/markdown" } },
		);
	};
}

const plainTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function renderText(component) {
	return component.render(160).join("\n").trimEnd();
}

test("a complete single-page fetch publishes a content result without unnecessary retrieval guidance", async () => {
	const tools = await loadRegisteredTools();
	assert.ok(tools.fetchContent);
	assert.match(tools.fetchContent.description, /contentResultId/);
	assert.match(tools.fetchContent.promptSnippet, /contentResultId/);
	mockJinaPages({
		"http://127.0.0.1/short": { title: "Short page", content: "Complete page content. ".repeat(30) },
	});

	const result = await tools.fetchContent.execute("fetch-short", { url: "http://127.0.0.1/short" });

	assert.equal(typeof result.details.contentResultId, "string");
	assert.equal("responseId" in result.details, false);
	assert.doesNotMatch(result.content.at(-1).text, /get_search_content/);
});

test("a truncated single-page fetch gives an exact resultId call that returns the complete page", async () => {
	const tools = await loadRegisteredTools();
	assert.ok(tools.fetchContent);
	assert.ok(tools.getSearchContent);
	assert.deepEqual(tools.getSearchContent.parameters.required, ["resultId"]);
	assert.equal("responseId" in tools.getSearchContent.parameters.properties, false);
	assert.match(tools.getSearchContent.description, /resultId/);
	assert.match(tools.getSearchContent.promptSnippet, /resultId/);
	assert.doesNotMatch(tools.getSearchContent.promptSnippet, /responseId/);
	const fullContent = `Opening marker\n${"long content ".repeat(2600)}\nClosing marker`;
	mockJinaPages({
		"http://127.0.0.1/long": { title: "Long page", content: fullContent },
	});

	const fetched = await tools.fetchContent.execute("fetch-long", { url: "http://127.0.0.1/long" });
	const { contentResultId } = fetched.details;
	assert.match(
		fetched.content.at(-1).text,
		new RegExp(`get_search_content\\(\\{ resultId: "${contentResultId}" \\}\\)`),
	);

	const retrieved = await tools.getSearchContent.execute("get-long", { resultId: contentResultId });
	assert.match(retrieved.content[0].text, /Opening marker/);
	assert.match(retrieved.content[0].text, /Closing marker/);
});

test("a multi-page content result lists choices and accepts URL or URL-index selection", async () => {
	const tools = await loadRegisteredTools();
	assert.ok(tools.fetchContent);
	assert.ok(tools.getSearchContent);
	const firstUrl = "http://127.0.0.1/first";
	const secondUrl = "http://127.0.0.1/second";
	mockJinaPages({
		[firstUrl]: { title: "First page", content: "First page body. ".repeat(30) },
		[secondUrl]: { title: "Second page", content: "Second page body. ".repeat(30) },
	});

	const fetched = await tools.fetchContent.execute("fetch-many", { urls: [firstUrl, secondUrl] });
	const { contentResultId } = fetched.details;
	assert.match(
		fetched.content[0].text,
		new RegExp(`get_search_content\\(\\{ resultId: "${contentResultId}" \\}\\)`),
	);

	const choices = await tools.getSearchContent.execute("list-many", { resultId: contentResultId });
	assert.match(choices.content[0].text, new RegExp(`0: ${firstUrl}`));
	assert.match(choices.content[0].text, new RegExp(`1: ${secondUrl}`));

	const byUrl = await tools.getSearchContent.execute("get-first", { resultId: contentResultId, url: firstUrl });
	assert.match(byUrl.content[0].text, /First page body/);
	const byIndex = await tools.getSearchContent.execute("get-second", { resultId: contentResultId, urlIndex: 1 });
	assert.match(byIndex.content[0].text, /Second page body/);
});

test("content retrieval errors name resultId and show corrective choices", async () => {
	const tools = await loadRegisteredTools();
	assert.ok(tools.fetchContent);
	assert.ok(tools.getSearchContent);

	const missing = await tools.getSearchContent.execute("get-missing", { resultId: "missing-reference" });
	assert.match(missing.content[0].text, /resultId "missing-reference"/);
	assert.equal(missing.details.resultId, "missing-reference");

	const firstUrl = "http://127.0.0.1/error-first";
	const secondUrl = "http://127.0.0.1/error-second";
	mockJinaPages({
		[firstUrl]: { title: "First", content: "First available page. ".repeat(30) },
		[secondUrl]: { title: "Second", content: "Second available page. ".repeat(30) },
	});
	const fetched = await tools.fetchContent.execute("fetch-errors", { urls: [firstUrl, secondUrl] });
	const { contentResultId } = fetched.details;

	const unknownUrl = await tools.getSearchContent.execute("unknown-url", {
		resultId: contentResultId,
		url: "http://127.0.0.1/unknown",
	});
	assert.match(unknownUrl.content[0].text, new RegExp(`resultId "${contentResultId}"`));
	assert.match(unknownUrl.content[0].text, new RegExp(`0: ${firstUrl}`));
	assert.match(unknownUrl.content[0].text, new RegExp(`1: ${secondUrl}`));

	const outOfRange = await tools.getSearchContent.execute("bad-index", {
		resultId: contentResultId,
		urlIndex: 4,
	});
	assert.match(outOfRange.content[0].text, new RegExp(`resultId "${contentResultId}"`));
	assert.match(outOfRange.content[0].text, new RegExp(`0: ${firstUrl}`));
	assert.match(outOfRange.content[0].text, new RegExp(`1: ${secondUrl}`));

	const failedFetch = await tools.fetchContent.execute("fetch-failure", { url: "not-a-url" });
	const failedResult = await tools.getSearchContent.execute("get-failure", {
		resultId: failedFetch.details.contentResultId,
	});
	assert.match(failedResult.content[0].text, new RegExp(`resultId "${failedFetch.details.contentResultId}"`));
	assert.match(failedResult.content[0].text, /not-a-url/);
});

test("a failed content publication is not retrievable from another cached runtime", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-content-publication-"));
	let unpublishedResultId;
	const publicationError = new Error("This extension ctx is stale");
	const failingRuntime = await loadRegisteredTools([], {
		configDir,
		appendEntry(_customType, data) {
			unpublishedResultId = data.id;
			throw publicationError;
		},
	});
	const otherRuntime = await loadRegisteredTools([], { configDir });
	assert.ok(failingRuntime.fetchContent);
	assert.ok(otherRuntime.getSearchContent);
	mockJinaPages({
		"http://127.0.0.1/unpublished": {
			title: "Unpublished page",
			content: "This content must remain private to the failed publication.",
		},
	});

	await assert.rejects(
		failingRuntime.fetchContent.execute("fetch-unpublished", { url: "http://127.0.0.1/unpublished" }),
		publicationError,
	);
	assert.equal(failingRuntime.entries.length, 0);
	assert.equal(typeof unpublishedResultId, "string");

	const retrieved = await otherRuntime.getSearchContent.execute("get-unpublished", {
		resultId: unpublishedResultId,
	});
	assert.equal(retrieved.details.error, "Not found");
	assert.equal(retrieved.details.resultId, unpublishedResultId);
	assert.match(retrieved.content[0].text, new RegExp(`resultId "${unpublishedResultId}"`));

	await loadRegisteredTools([], { configDir });
});

test("a restored single-page content result opens with resultId alone", async () => {
	const initial = await loadRegisteredTools();
	assert.ok(initial.fetchContent);
	mockJinaPages({
		"http://127.0.0.1/restored": { title: "Restored page", content: "Restored body marker. ".repeat(30) },
	});
	const fetched = await initial.fetchContent.execute("fetch-restored", { url: "http://127.0.0.1/restored" });
	const storedEntry = initial.entries.find((entry) => entry.customType === "web-search-results");
	assert.ok(storedEntry);

	const restored = await loadRegisteredTools([{
		type: "custom",
		customType: storedEntry.customType,
		data: storedEntry.data,
	}]);
	assert.ok(restored.getSearchContent);
	const result = await restored.getSearchContent.execute("get-restored", {
		resultId: fetched.details.contentResultId,
	});

	assert.match(result.content[0].text, /Restored body marker/);
});

test("a restored multi-page content result lists and selects the saved pages", async () => {
	const initial = await loadRegisteredTools();
	assert.ok(initial.fetchContent);
	const firstUrl = "http://127.0.0.1/restored-first";
	const secondUrl = "http://127.0.0.1/restored-second";
	mockJinaPages({
		[firstUrl]: { title: "Restored first", content: "Restored first marker. ".repeat(30) },
		[secondUrl]: { title: "Restored second", content: "Restored second marker. ".repeat(30) },
	});
	const fetched = await initial.fetchContent.execute("fetch-restored-many", { urls: [firstUrl, secondUrl] });
	const storedEntry = initial.entries.find((entry) => entry.customType === "web-search-results");
	assert.ok(storedEntry);

	const restored = await loadRegisteredTools([{
		type: "custom",
		customType: storedEntry.customType,
		data: storedEntry.data,
	}]);
	assert.ok(restored.getSearchContent);
	const choices = await restored.getSearchContent.execute("list-restored-many", {
		resultId: fetched.details.contentResultId,
	});
	assert.match(choices.content[0].text, new RegExp(`0: ${firstUrl}`));
	assert.match(choices.content[0].text, new RegExp(`1: ${secondUrl}`));

	const byUrl = await restored.getSearchContent.execute("get-restored-first", {
		resultId: fetched.details.contentResultId,
		url: firstUrl,
	});
	assert.match(byUrl.content[0].text, /Restored first marker/);
	const byIndex = await restored.getSearchContent.execute("get-restored-second", {
		resultId: fetched.details.contentResultId,
		urlIndex: 1,
	});
	assert.match(byIndex.content[0].text, /Restored second marker/);
});

test("registered fetched-content renderers use contentResultId and resultId labels", async () => {
	const tools = await loadRegisteredTools();
	assert.ok(tools.fetchContent);
	assert.ok(tools.getSearchContent);
	const firstUrl = "http://127.0.0.1/render-first";
	const secondUrl = "http://127.0.0.1/render-second";
	mockJinaPages({
		[firstUrl]: { title: "Rendered first", content: "Rendered first body. ".repeat(30) },
		[secondUrl]: { title: "Rendered second", content: "Rendered second body. ".repeat(30) },
	});

	const fetched = await tools.fetchContent.execute("fetch-render", { url: firstUrl });
	const fetchedText = renderText(tools.fetchContent.renderResult(fetched, { expanded: true, isPartial: false }, plainTheme));
	assert.match(fetchedText, new RegExp(`contentResultId: ${fetched.details.contentResultId}`));
	assert.doesNotMatch(fetchedText, /responseId|response id/i);

	const failed = await tools.fetchContent.execute("fetch-render-error", { url: "not-a-url" });
	const failedText = renderText(tools.fetchContent.renderResult(failed, { expanded: true, isPartial: false }, plainTheme));
	assert.match(failedText, new RegExp(`contentResultId: ${failed.details.contentResultId}`));
	assert.doesNotMatch(failedText, /responseId|response id/i);

	const many = await tools.fetchContent.execute("fetch-render-many", { urls: [firstUrl, secondUrl] });
	const retrievalCall = renderText(tools.getSearchContent.renderCall({ resultId: many.details.contentResultId }, plainTheme));
	assert.match(retrievalCall, new RegExp(`resultId=${many.details.contentResultId}`));
	const choices = await tools.getSearchContent.execute("render-list", { resultId: many.details.contentResultId });
	const choicesText = renderText(tools.getSearchContent.renderResult(choices, { expanded: true, isPartial: false }, plainTheme));
	assert.match(choicesText, new RegExp(`resultId: ${many.details.contentResultId}`));
	assert.doesNotMatch(choicesText, /responseId|response id/i);

	const unknownUrl = await tools.getSearchContent.execute("render-unknown-url", {
		resultId: many.details.contentResultId,
		url: "http://127.0.0.1/render-unknown",
	});
	const unknownUrlText = renderText(tools.getSearchContent.renderResult(unknownUrl, { expanded: true, isPartial: false }, plainTheme));
	assert.match(unknownUrlText, new RegExp(`0: ${firstUrl}`));
	assert.match(unknownUrlText, new RegExp(`1: ${secondUrl}`));

	const outOfRange = await tools.getSearchContent.execute("render-bad-index", {
		resultId: many.details.contentResultId,
		urlIndex: 3,
	});
	const outOfRangeText = renderText(tools.getSearchContent.renderResult(outOfRange, { expanded: true, isPartial: false }, plainTheme));
	assert.match(outOfRangeText, new RegExp(`0: ${firstUrl}`));
	assert.match(outOfRangeText, new RegExp(`1: ${secondUrl}`));
});
