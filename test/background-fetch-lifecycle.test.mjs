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

async function createRuntime(configDir, label) {
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
		sessionManager: { getBranch: () => [] },
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
	assert.equal("searchId" in result.details, false);
	assert.equal("fetchId" in result.details, false);
	assert.match(result.content[0].text, new RegExp(`contentResultId: ${result.details.contentResultId}`));
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
