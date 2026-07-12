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

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function settlesWithin(promise, label) {
	let timeoutId;
	try {
		return await Promise.race([
			promise,
			new Promise((_resolve, reject) => {
				timeoutId = setTimeout(() => reject(new Error(`${label} did not settle promptly`)), 100);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

async function assertNoLateEffects(runtime, updates, releaseLateStep, requestCount) {
	const entryCount = runtime.entries.length;
	const messageCount = runtime.sent.length;
	const updateCount = updates.length;
	const unhandled = [];
	const onUnhandled = (error) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	try {
		releaseLateStep();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}
	assert.equal(runtime.entries.length, entryCount, "late retrieval must not store or publish");
	assert.equal(runtime.sent.length, messageCount, "late retrieval must not send a message or trigger a turn");
	assert.equal(updates.length, updateCount, "late retrieval must not report progress");
	assert.equal(requestCount(), 0, "late retrieval must not start another request");
	assert.deepEqual(unhandled, [], "late retrieval must not reject without a handler");
}

async function createRuntime(label) {
	const configDir = await mkdtemp(join(tmpdir(), `pi-web-access-terminal-${label}-`));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify({
		workflow: "none",
		ssrf: { allowRanges: ["127.0.0.0/8"] },
	}));
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.env.BRAVE_API_KEY = "brave-test-key";

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
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, context);
	}
	return { extension, runtime, sent, entries, context };
}

function tool(extension, name) {
	const definition = extension.tools.get(name)?.definition;
	assert.ok(definition, `${name} should be registered`);
	return definition;
}

function installGatedContentFetch(contentGate) {
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return new Response(JSON.stringify({
				web: { results: [{ title: "Article", url: "http://127.0.0.1/article", description: "Result" }] },
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
}

test("full-content web search waits and stores content before terminal resolution", async () => {
	const contentGate = deferred();
	installGatedContentFetch(contentGate);
	const runtime = await createRuntime("wait");
	const updates = [];
	let settled = false;
	const execution = tool(runtime.extension, "web_search").execute(
		"terminal-search",
		{ query: "terminal content", provider: "brave", workflow: "none", includeContent: true },
		undefined,
		(update) => updates.push(update),
		runtime.context,
	).then((result) => {
		settled = true;
		return result;
	});

	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(settled, false, "execution must remain pending during content retrieval");
	assert.equal(runtime.sent.length, 0, "content retrieval must not send follow-up messages");

	contentGate.resolve();
	const result = await execution;
	assert.ok(result.details.fetchId);
	assert.equal(result.details.contentReady, 1);
	assert.equal(result.details.contentErrors, 0);
	assert.equal(result.details.fetchUrls, undefined);
	assert.ok(updates.some((update) => update.details?.phase === "content"));
	const retrieved = await tool(runtime.extension, "get_search_content").execute(
		"retrieve",
		{ responseId: result.details.fetchId, urlIndex: 0 },
	);
	assert.equal(retrieved.details.error, undefined);
	assert.match(retrieved.content[0].text, /# Article/);
	assert.equal(runtime.sent.length, 0, "terminal resolution must not send a follow-up message");
});

function braveSearchResponse(urls) {
	return new Response(JSON.stringify({
		web: { results: urls.map((url, index) => ({ title: `Article ${index + 1}`, url, description: "Result" })) },
	}), { status: 200, headers: { "content-type": "application/json" } });
}

function jinaResponse(url, title = "Article") {
	return new Response(
		`Title: ${title}\nURL Source: ${url}\nMarkdown Content:\n# ${title}\n${"content ".repeat(80)}`,
		{ status: 200, headers: { "content-type": "text/markdown" } },
	);
}

test("web search without full content skips the content phase", async () => {
	const runtime = await createRuntime("no-content");
	const updates = [];
	let contentRequests = 0;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/article"]);
		}
		contentRequests += 1;
		throw new Error(`Unexpected content request: ${requestUrl}`);
	};

	const result = await tool(runtime.extension, "web_search").execute(
		"no-content-search",
		{ query: "quick search", provider: "brave", workflow: "none" },
		undefined,
		(update) => updates.push(update),
		runtime.context,
	);

	assert.equal(result.details.fetchId, null);
	assert.equal(contentRequests, 0);
	assert.equal(updates.some((update) => update.details?.phase === "content"), false);
});

test("content deadline retains completed sources and terminally abandons a non-settling source", async () => {
	const runtime = await createRuntime("deadline");
	const deadline = new AbortController();
	const slowFetch = deferred();
	const originalTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => deadline.signal;
	const updates = [];
	let requestsAfterDeadline = 0;
	let deadlinePassed = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (deadlinePassed) requestsAfterDeadline += 1;
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/fast", "http://127.0.0.1/slow"]);
		}
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/fast") return jinaResponse("http://127.0.0.1/fast", "Fast");
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/slow") return slowFetch.promise;
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};
	try {
		const execution = tool(runtime.extension, "web_search").execute(
			"deadline-search",
			{ query: "partial content", provider: "brave", workflow: "none", includeContent: true },
			undefined,
			(update) => updates.push(update),
			runtime.context,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		deadlinePassed = true;
		deadline.abort(new DOMException("deadline", "TimeoutError"));
		const result = await settlesWithin(execution, "content deadline");

		assert.equal(result.details.contentReady, 1);
		assert.equal(result.details.contentErrors, 1);
		const fast = await tool(runtime.extension, "get_search_content").execute("fast", { responseId: result.details.fetchId, urlIndex: 0 });
		const slow = await tool(runtime.extension, "get_search_content").execute("slow", { responseId: result.details.fetchId, urlIndex: 1 });
		assert.match(fast.content[0].text, /# Fast/);
		assert.match(slow.details.error, /timed out after 60 seconds/);
		assert.ok(updates.some((update) => update.details?.phase === "content" && update.details.completed === 1 && update.details.failed === 1 && update.details.remaining === 0));
		await assertNoLateEffects(runtime, updates, () => slowFetch.resolve(jinaResponse("http://127.0.0.1/slow", "Slow")), () => requestsAfterDeadline);
	} finally {
		AbortSignal.timeout = originalTimeout;
	}
});

test("caller cancellation terminally abandons a non-settling content step", async () => {
	const runtime = await createRuntime("caller-cancel");
	const controller = new AbortController();
	const callerReason = new Error("caller cancelled");
	const slowFetch = deferred();
	const updates = [];
	let requestsAfterCancellation = 0;
	let cancelled = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (cancelled) requestsAfterCancellation += 1;
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) return braveSearchResponse(["http://127.0.0.1/slow"]);
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/slow") return slowFetch.promise;
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const execution = tool(runtime.extension, "web_search").execute(
		"cancel-search",
		{ query: "cancel content", provider: "brave", workflow: "none", includeContent: true },
		controller.signal,
		(update) => updates.push(update),
		runtime.context,
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	cancelled = true;
	controller.abort(callerReason);
	await assert.rejects(settlesWithin(execution, "caller cancellation"), (error) => error === callerReason);
	assert.deepEqual(runtime.entries, []);
	assert.deepEqual(runtime.sent, []);
	await assertNoLateEffects(runtime, updates, () => slowFetch.resolve(jinaResponse("http://127.0.0.1/slow", "Slow")), () => requestsAfterCancellation);
});

test("session replacement terminally abandons a non-settling content step", async () => {
	const runtime = await createRuntime("session-change");
	const slowFetch = deferred();
	const updates = [];
	let requestsAfterCancellation = 0;
	let cancelled = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (cancelled) requestsAfterCancellation += 1;
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) return braveSearchResponse(["http://127.0.0.1/slow"]);
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/slow") return slowFetch.promise;
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const execution = tool(runtime.extension, "web_search").execute(
		"session-search",
		{ query: "session content", provider: "brave", workflow: "none", includeContent: true },
		undefined,
		(update) => updates.push(update),
		runtime.context,
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	cancelled = true;
	for (const handler of runtime.extension.handlers.get("session_tree") ?? []) {
		await handler({}, runtime.context);
	}
	const result = await settlesWithin(execution, "session replacement");
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "session-changed");
	assert.doesNotMatch(result.content[0].text, /stale/i);
	assert.deepEqual(runtime.entries, []);
	assert.deepEqual(runtime.sent, []);
	await assertNoLateEffects(runtime, updates, () => slowFetch.resolve(jinaResponse("http://127.0.0.1/slow", "Slow")), () => requestsAfterCancellation);
});

test("shutdown terminally abandons a non-settling content step", async () => {
	const runtime = await createRuntime("shutdown");
	const slowFetch = deferred();
	const updates = [];
	let requestsAfterCancellation = 0;
	let cancelled = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (cancelled) requestsAfterCancellation += 1;
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) return braveSearchResponse(["http://127.0.0.1/slow"]);
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/slow") return slowFetch.promise;
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const execution = tool(runtime.extension, "web_search").execute(
		"shutdown-search",
		{ query: "shutdown content", provider: "brave", workflow: "none", includeContent: true },
		undefined,
		(update) => updates.push(update),
		runtime.context,
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	cancelled = true;
	for (const handler of runtime.extension.handlers.get("session_shutdown") ?? []) {
		await handler({});
	}
	const result = await settlesWithin(execution, "session shutdown");
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "session-changed");
	assert.deepEqual(runtime.entries, []);
	assert.deepEqual(runtime.sent, []);
	await assertNoLateEffects(runtime, updates, () => slowFetch.reject(new Error("late network failure")), () => requestsAfterCancellation);
});

test("duplicate source URLs are fetched and stored once in first-result order", async () => {
	const runtime = await createRuntime("duplicate");
	let contentRequests = 0;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/article#first", "http://127.0.0.1/article#second"]);
		}
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/article#first") {
			contentRequests += 1;
			return jinaResponse("http://127.0.0.1/article#first");
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const result = await tool(runtime.extension, "web_search").execute(
		"duplicate-search",
		{ query: "duplicate content", provider: "brave", workflow: "none", includeContent: true },
		undefined,
		undefined,
		runtime.context,
	);
	assert.equal(contentRequests, 1);
	assert.equal(result.details.contentReady, 1);
	const outOfRange = await tool(runtime.extension, "get_search_content").execute("second", { responseId: result.details.fetchId, urlIndex: 1 });
	assert.equal(outOfRange.details.error, "Index out of range");
});

test("provider-inline and retrieved content share one ordered continuation identity", async () => {
	const runtime = await createRuntime("inline-merge");
	process.env.EXA_API_KEY = "exa-test-key";
	const contentRequests = [];
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl === "https://api.exa.ai/search") {
			return new Response(JSON.stringify({ results: [
				{ title: "Inline", url: "https://example.com/inline", text: "# Inline\nProvider supplied content" },
				{ title: "Missing", url: "http://127.0.0.1/missing" },
			] }), { status: 200, headers: { "content-type": "application/json" } });
		}
		contentRequests.push(requestUrl);
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/missing") return jinaResponse("http://127.0.0.1/missing", "Missing");
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const result = await tool(runtime.extension, "web_search").execute(
		"inline-search",
		{ query: "mixed content", provider: "exa", workflow: "none", includeContent: true },
		undefined,
		undefined,
		runtime.context,
	);
	assert.equal(contentRequests.some((url) => url.includes("example.com/inline")), false);
	assert.ok(contentRequests.some((url) => url.includes("127.0.0.1/missing")));
	assert.equal(result.details.contentReady, 2);
	assert.equal(result.details.contentErrors, 0);
	const inline = await tool(runtime.extension, "get_search_content").execute("inline", { responseId: result.details.fetchId, urlIndex: 0 });
	const missing = await tool(runtime.extension, "get_search_content").execute("missing", { responseId: result.details.fetchId, urlIndex: 1 });
	assert.match(inline.content[0].text, /Provider supplied content/);
	assert.match(missing.content[0].text, /# Missing/);
});
