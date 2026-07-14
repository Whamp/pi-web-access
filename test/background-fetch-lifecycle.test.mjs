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
const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-lifecycle-"));
process.env.PI_CODING_AGENT_DIR = configDir;
process.env.BRAVE_API_KEY = "brave-test-key";
await writeFile(join(configDir, "web-search.json"), JSON.stringify({ ssrf: { allowRanges: ["127.0.0.0/8"] } }));

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.fail("condition was not met before timeout");
}

async function createRuntime(configDir, label, branch = []) {
	const runtime = createExtensionRuntime();
	const sent = [];
	const entries = [];
	runtime.sendMessage = (message, options) => sent.push({ message, options });
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
	assert.deepEqual(loaded.errors, [], `extension load failed for runtime ${label}`);
	const extension = loaded.extensions[0];
	assert.ok(extension, `extension missing for runtime ${label}`);
	const context = {
		hasUI: false,
		mode: "print",
		cwd: configDir,
		sessionManager: { getBranch: () => branch },
		ui: { setWidget() {}, notify() {} },
	};
	return {
		extension,
		runtime,
		sent,
		entries,
		async start() {
			for (const handler of extension.handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, context);
			}
		},
	};
}

async function startBackgroundSearch(runtime, callId) {
	const webSearch = runtime.extension.tools.get("web_search")?.definition;
	assert.ok(webSearch, "runtime should register web_search");
	const result = await webSearch.execute(
		callId,
		{ query: "runtime isolation", provider: "brave", workflow: "none", includeContent: true },
		undefined,
		undefined,
		{ hasUI: false },
	);
	assert.ok(result.details.contentResultId, "web_search should start a background fetch");
	assert.equal(typeof result.details.searchResultId, "string");
	assert.deepEqual(Object.keys(result.details).sort(), [
		"contentResultId",
		"fetchUrls",
		"includeContent",
		"queries",
		"queryCount",
		"searchResultId",
		"successfulQueries",
		"totalResults",
	]);
	assert.match(result.content[0].text, new RegExp(`contentResultId: ${result.details.contentResultId}`));
	assert.doesNotMatch(result.content[0].text, /get_search_content/);
	return result.details.contentResultId;
}

test("a second cached extension runtime cannot cancel the first runtime's background fetch", async () => {
	const contentGate = deferred();
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return new Response(JSON.stringify({
				web: {
					results: [{
						title: "Article",
						url: "http://127.0.0.1/article",
						description: "A deterministic test result",
					}],
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/article") {
			await contentGate.promise;
			return new Response(
				`Title: Article\nURL Source: http://127.0.0.1/article\nMarkdown Content:\n# Article\n${"content ".repeat(80)}`,
				{ status: 200, headers: { "content-type": "text/markdown" } },
			);
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const runtimeA = await createRuntime(configDir, "A");
	await runtimeA.start();
	const contentResultId = await startBackgroundSearch(runtimeA, "search-a");

	const runtimeB = await createRuntime(configDir, "B");
	await runtimeB.start();
	contentGate.resolve();

	await waitFor(() => runtimeA.sent.length > 0);
	assert.equal(runtimeA.sent.length, 1);
	assert.match(runtimeA.sent[0].message.content, new RegExp(`contentResultId: ${contentResultId}`));
	assert.match(
		runtimeA.sent[0].message.content,
		new RegExp(`get_search_content\\(\\{ resultId: "${contentResultId}" \\}\\)`),
	);
	assert.equal(runtimeB.sent.length, 0);

	const getSearchContent = runtimeA.extension.tools.get("get_search_content")?.definition;
	assert.ok(getSearchContent, "runtime should register get_search_content");
	const retrieved = await getSearchContent.execute("retrieve-a", { resultId: contentResultId });
	assert.equal(retrieved.details.error, undefined);
	assert.match(retrieved.content[0].text, /# Article/);

	const branch = runtimeA.entries.map(({ customType, data }) => ({ type: "custom", customType, data }));
	const restoredRuntime = await createRuntime(configDir, "restored", branch);
	await restoredRuntime.start();
	const restoredGetSearchContent = restoredRuntime.extension.tools.get("get_search_content")?.definition;
	assert.ok(restoredGetSearchContent, "restored runtime should register get_search_content");
	const restored = await restoredGetSearchContent.execute("retrieve-restored", { resultId: contentResultId });
	assert.equal(restored.details.error, undefined);
	assert.match(restored.content[0].text, /# Article/);
});

test("an all-error background fetch reports the failed content reference without retrieval guidance", async () => {
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return new Response(JSON.stringify({
				web: {
					results: [{
						title: "Unavailable article",
						url: "http://127.0.0.1/unavailable",
						description: "A deterministic failed content result",
					}],
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (
			requestUrl === "https://r.jina.ai/http://127.0.0.1/unavailable"
			|| requestUrl === "http://127.0.0.1/unavailable"
		) {
			return new Response("upstream failed", { status: 503, statusText: "Service Unavailable" });
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const runtime = await createRuntime(configDir, "failed");
	await runtime.start();
	const contentResultId = await startBackgroundSearch(runtime, "search-failed");

	await waitFor(() => runtime.sent.length > 0);
	assert.equal(runtime.sent.length, 1);
	assert.equal(runtime.sent[0].message.customType, "web-search-error");
	assert.match(runtime.sent[0].message.content, /Content fetch failed/);
	assert.match(runtime.sent[0].message.content, new RegExp(`contentResultId: ${contentResultId}`));
	assert.doesNotMatch(runtime.sent[0].message.content, /get_search_content|Full page content now available/);
});

test("background completion from an expired runtime does not leak a stale-context rejection", async () => {
	const contentGate = deferred();
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return new Response(JSON.stringify({
				web: {
					results: [{
						title: "Article",
						url: "http://127.0.0.1/article",
						description: "A deterministic test result",
					}],
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/article") {
			await contentGate.promise;
			return new Response(
				`Title: Article\nURL Source: http://127.0.0.1/article\nMarkdown Content:\n# Article\n${"content ".repeat(80)}`,
				{ status: 200, headers: { "content-type": "text/markdown" } },
			);
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const runtime = await createRuntime(configDir, "expired");
	await runtime.start();
	await startBackgroundSearch(runtime, "search-expired");
	const entryCountBeforeCompletion = runtime.entries.length;
	const publicationAttempted = deferred();
	const assertActive = runtime.runtime.assertActive;
	runtime.runtime.assertActive = () => {
		publicationAttempted.resolve();
		assertActive();
	};
	runtime.runtime.invalidate();

	let unhandled;
	const captureUnhandled = (error) => {
		unhandled = error;
	};
	process.once("unhandledRejection", captureUnhandled);
	contentGate.resolve();
	await publicationAttempted.promise;
	await new Promise((resolve) => setImmediate(resolve));
	process.removeListener("unhandledRejection", captureUnhandled);

	assert.equal(
		unhandled,
		undefined,
		`background completion leaked a stale-context rejection: ${unhandled?.stack ?? unhandled}`,
	);
	assert.equal(runtime.sent.length, 0);
	assert.equal(runtime.entries.length, entryCountBeforeCompletion);
});
