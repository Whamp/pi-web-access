import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

async function waitForFile(path, label) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return await readFile(path, "utf8");
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`${label} was not created`);
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function assertNoLateEffects(runtime, updates, releaseLateStep, requestCount) {
	const entryCount = runtime.entries.length;
	const messageCount = runtime.sent.length;
	const updateCount = updates.length;
	const widgetUpdateCount = runtime.widgetUpdates.length;
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
	assert.equal(runtime.widgetUpdates.length, widgetUpdateCount, "late retrieval must not update activity UI");
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
	const widgetUpdates = [];
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
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget: (...args) => widgetUpdates.push(args),
			notify() {},
		},
	};
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, context);
	}
	return { extension, runtime, sent, entries, widgetUpdates, context };
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

test("caller cancellation closes a Jina body before tool settlement", async () => {
	const runtime = await createRuntime("caller-cancel-jina-body");
	const controller = new AbortController();
	const callerReason = new Error("cancel Jina body");
	const bodyStarted = deferred();
	let bodyCancelled = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/jina-body"]);
		}
		if (requestUrl === "http://127.0.0.1/jina-body") {
			return new Response("unavailable", { status: 502 });
		}
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/jina-body") {
			return new Response(new ReadableStream({
				pull() {
					bodyStarted.resolve();
				},
				cancel() {
					bodyCancelled = true;
				},
			}), { status: 200, headers: { "content-type": "text/markdown" } });
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const execution = tool(runtime.extension, "web_search").execute(
		"cancel-jina-body",
		{ query: "cancel Jina body", provider: "brave", workflow: "none", includeContent: true },
		controller.signal,
		undefined,
		runtime.context,
	);
	await settlesWithin(bodyStarted.promise, "Jina body start");
	controller.abort(callerReason);
	await assert.rejects(settlesWithin(execution, "Jina body cancellation"), (error) => error === callerReason);
	assert.equal(bodyCancelled, true, "Jina body must cancel before web_search settles");
	assert.deepEqual(runtime.entries, []);
});

test("caller cancellation settles while a started fallback ignores abort", async () => {
	const runtime = await createRuntime("caller-cancel-started-fallback");
	const controller = new AbortController();
	const callerReason = new Error("cancel started fallback");
	const fallbackStarted = deferred();
	const fallbackGate = deferred();
	const originalParallelKey = process.env.PARALLEL_API_KEY;
	process.env.PARALLEL_API_KEY = "parallel-terminal-test-key";
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/fallback"]);
		}
		if (requestUrl === "http://127.0.0.1/fallback" || requestUrl === "https://r.jina.ai/http://127.0.0.1/fallback") {
			return new Response("unavailable", { status: 502, statusText: "Bad Gateway" });
		}
		if (requestUrl === "https://api.parallel.ai/v1/extract") {
			fallbackStarted.resolve();
			return fallbackGate.promise;
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};
	const activityShortcut = runtime.extension.shortcuts.get("ctrl+shift+w");
	assert.ok(activityShortcut, "activity shortcut should be registered");
	await activityShortcut.handler(runtime.context);

	const execution = tool(runtime.extension, "web_search").execute(
		"cancel-started-fallback-search",
		{ query: "cancel started fallback", provider: "brave", workflow: "none", includeContent: true },
		controller.signal,
		undefined,
		runtime.context,
	);
	let widgetUpdatesAtSettlement;
	try {
		await settlesWithin(fallbackStarted.promise, "Parallel fallback start");
		controller.abort(callerReason);
		await assert.rejects(settlesWithin(execution, "started fallback cancellation"), (error) => error === callerReason);
		assert.deepEqual(runtime.entries, []);
		widgetUpdatesAtSettlement = runtime.widgetUpdates.length;
	} finally {
		fallbackGate.resolve(new Response(JSON.stringify({ results: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}));
		await settlesWithin(execution.catch(() => {}), "started fallback cleanup");
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		if (originalParallelKey === undefined) delete process.env.PARALLEL_API_KEY;
		else process.env.PARALLEL_API_KEY = originalParallelKey;
	}
	assert.equal(runtime.widgetUpdates.length, widgetUpdatesAtSettlement, "late fallback settlement must not update activity UI");
});

test("started Gemini URL Context settles on deadline, caller cancellation, session replacement, and shutdown", async () => {
	const originalGeminiKey = process.env.GEMINI_API_KEY;
	const originalParallelKey = process.env.PARALLEL_API_KEY;
	const originalTimeout = AbortSignal.timeout;
	process.env.GEMINI_API_KEY = "gemini-terminal-test-key";
	delete process.env.PARALLEL_API_KEY;
	const scenarios = [
		{
			label: "deadline",
			prepare() {
				const controller = new AbortController();
				AbortSignal.timeout = () => controller.signal;
				return { controller, toolSignal: undefined };
			},
			async trigger(_runtime, state) {
				state.controller.abort(new DOMException("content deadline", "TimeoutError"));
			},
			assertResult(result) {
				assert.equal(result.details.contentReady, 0);
				assert.equal(result.details.contentErrors, 1);
			},
		},
		{
			label: "caller",
			prepare() {
				const controller = new AbortController();
				return { controller, toolSignal: controller.signal };
			},
			async trigger(_runtime, state) {
				state.controller.abort(state.reason);
			},
			expectsRejection: true,
		},
		{
			label: "session-replacement",
			prepare: () => ({ toolSignal: undefined }),
			async trigger(runtime) {
				for (const handler of runtime.extension.handlers.get("session_tree") ?? []) {
					await handler({}, runtime.context);
				}
			},
			assertResult(result) {
				assert.equal(result.details.cancelled, true);
				assert.equal(result.details.cancelReason, "session-changed");
			},
		},
		{
			label: "shutdown",
			prepare: () => ({ toolSignal: undefined }),
			async trigger(runtime) {
				for (const handler of runtime.extension.handlers.get("session_shutdown") ?? []) {
					await handler({});
				}
			},
			assertResult(result) {
				assert.equal(result.details.cancelled, true);
				assert.equal(result.details.cancelReason, "session-changed");
			},
		},
	];

	try {
		for (const scenario of scenarios) {
			AbortSignal.timeout = originalTimeout;
			const runtime = await createRuntime(`started-gemini-${scenario.label}`);
			const geminiStarted = deferred();
			const geminiGate = deferred();
			const state = scenario.prepare();
			state.reason = new Error(`cancel Gemini on ${scenario.label}`);
			globalThis.fetch = async (url) => {
				const requestUrl = String(url);
				if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
					return braveSearchResponse([`http://127.0.0.1/gemini-${scenario.label}`]);
				}
				if (requestUrl === `http://127.0.0.1/gemini-${scenario.label}` || requestUrl === `https://r.jina.ai/http://127.0.0.1/gemini-${scenario.label}`) {
					return new Response("unavailable", { status: 502, statusText: "Bad Gateway" });
				}
				if (requestUrl.startsWith("https://generativelanguage.googleapis.com/")) {
					geminiStarted.resolve();
					return geminiGate.promise;
				}
				throw new Error(`Unexpected fetch: ${requestUrl}`);
			};
			const activityShortcut = runtime.extension.shortcuts.get("ctrl+shift+w");
			assert.ok(activityShortcut, "activity shortcut should be registered");
			await activityShortcut.handler(runtime.context);
			const execution = tool(runtime.extension, "web_search").execute(
				`started-gemini-${scenario.label}`,
				{ query: `started Gemini ${scenario.label}`, provider: "brave", workflow: "none", includeContent: true },
				state.toolSignal,
				undefined,
				runtime.context,
			);
			let widgetUpdatesAtSettlement;
			try {
				await settlesWithin(geminiStarted.promise, `${scenario.label} Gemini start`);
				await scenario.trigger(runtime, state);
				if (scenario.expectsRejection) {
					await assert.rejects(settlesWithin(execution, `${scenario.label} Gemini cancellation`), (error) => error === state.reason);
				} else {
					const result = await settlesWithin(execution, `${scenario.label} Gemini cancellation`);
					scenario.assertResult(result);
				}
				widgetUpdatesAtSettlement = runtime.widgetUpdates.length;
			} finally {
				geminiGate.resolve(new Response(JSON.stringify({
					candidates: [{ content: { parts: [{ text: `# Late Gemini ${scenario.label}\n${"content ".repeat(20)}` }] } }],
				}), { status: 200, headers: { "content-type": "application/json" } }));
				await execution.catch(() => {});
				await new Promise((resolve) => setImmediate(resolve));
				await new Promise((resolve) => setImmediate(resolve));
			}
			assert.equal(runtime.widgetUpdates.length, widgetUpdatesAtSettlement, `${scenario.label} late Gemini settlement must not update activity UI`);
		}
	} finally {
		AbortSignal.timeout = originalTimeout;
		if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
		else process.env.GEMINI_API_KEY = originalGeminiKey;
		if (originalParallelKey === undefined) delete process.env.PARALLEL_API_KEY;
		else process.env.PARALLEL_API_KEY = originalParallelKey;
	}
});

test("started Parallel fallback settles on deadline, session replacement, and shutdown", async () => {
	const originalParallelKey = process.env.PARALLEL_API_KEY;
	const originalTimeout = AbortSignal.timeout;
	process.env.PARALLEL_API_KEY = "parallel-terminal-test-key";
	const scenarios = [
		{
			label: "deadline",
			prepare() {
				const deadline = new AbortController();
				AbortSignal.timeout = () => deadline.signal;
				return deadline;
			},
			async trigger(_runtime, deadline) {
				deadline.abort(new DOMException("content deadline", "TimeoutError"));
			},
			assertResult(result) {
				assert.equal(result.details.contentErrors, 1);
			},
		},
		{
			label: "session-replacement",
			prepare: () => undefined,
			async trigger(runtime) {
				for (const handler of runtime.extension.handlers.get("session_tree") ?? []) {
					await handler({}, runtime.context);
				}
			},
			assertResult(result) {
				assert.equal(result.details.cancelled, true);
				assert.equal(result.details.cancelReason, "session-changed");
			},
		},
		{
			label: "shutdown",
			prepare: () => undefined,
			async trigger(runtime) {
				for (const handler of runtime.extension.handlers.get("session_shutdown") ?? []) {
					await handler({});
				}
			},
			assertResult(result) {
				assert.equal(result.details.cancelled, true);
				assert.equal(result.details.cancelReason, "session-changed");
			},
		},
	];

	try {
		for (const scenario of scenarios) {
			AbortSignal.timeout = originalTimeout;
			const runtime = await createRuntime(`started-parallel-${scenario.label}`);
			const fallbackStarted = deferred();
			const fallbackGate = deferred();
			let lifecycleEnded = false;
			let requestsAfterLifecycle = 0;
			globalThis.fetch = async (url) => {
				const requestUrl = String(url);
				if (lifecycleEnded) requestsAfterLifecycle += 1;
				if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
					return braveSearchResponse([`http://127.0.0.1/${scenario.label}`]);
				}
				if (requestUrl === `http://127.0.0.1/${scenario.label}` || requestUrl === `https://r.jina.ai/http://127.0.0.1/${scenario.label}`) {
					return new Response("unavailable", { status: 502, statusText: "Bad Gateway" });
				}
				if (requestUrl === "https://api.parallel.ai/v1/extract") {
					fallbackStarted.resolve();
					return fallbackGate.promise;
				}
				throw new Error(`Unexpected fetch: ${requestUrl}`);
			};
			const prepared = scenario.prepare();
			const execution = tool(runtime.extension, "web_search").execute(
				`started-parallel-${scenario.label}`,
				{ query: `started parallel ${scenario.label}`, provider: "brave", workflow: "none", includeContent: true },
				undefined,
				undefined,
				runtime.context,
			);
			let widgetUpdatesAtSettlement;
			try {
				await settlesWithin(fallbackStarted.promise, `${scenario.label} Parallel fallback start`);
				lifecycleEnded = true;
				await scenario.trigger(runtime, prepared);
				const result = await settlesWithin(execution, `${scenario.label} started fallback cancellation`);
				scenario.assertResult(result);
				widgetUpdatesAtSettlement = runtime.widgetUpdates.length;
			} finally {
				fallbackGate.resolve(new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}));
				await settlesWithin(execution.catch(() => {}), `${scenario.label} started fallback cleanup`);
				await new Promise((resolve) => setImmediate(resolve));
				await new Promise((resolve) => setImmediate(resolve));
			}
			assert.equal(requestsAfterLifecycle, 0, `${scenario.label} must not start another request`);
			assert.equal(runtime.widgetUpdates.length, widgetUpdatesAtSettlement, `${scenario.label} late settlement must not update activity UI`);
		}
	} finally {
		AbortSignal.timeout = originalTimeout;
		if (originalParallelKey === undefined) delete process.env.PARALLEL_API_KEY;
		else process.env.PARALLEL_API_KEY = originalParallelKey;
	}
});

test("caller cancellation settles while content is queued behind unrelated retrievals", async () => {
	const runtime = await createRuntime("caller-cancel-queued-content");
	const blockerControllers = Array.from({ length: 3 }, () => new AbortController());
	const blockerGates = Array.from({ length: 3 }, () => deferred());
	const blockerStarted = Array.from({ length: 3 }, () => deferred());
	let searchCount = 0;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			const index = searchCount++;
			return braveSearchResponse([`http://127.0.0.1/content-${index}`]);
		}
		const match = requestUrl.match(/^http:\/\/127\.0\.0\.1\/content-(\d+)$/);
		if (match) {
			const index = Number(match[1]);
			if (index < blockerStarted.length) {
				blockerStarted[index].resolve();
				return blockerGates[index].promise;
			}
			throw new Error("queued content should not start after caller cancellation");
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const blockers = blockerControllers.map((controller, index) => tool(runtime.extension, "web_search").execute(
		`queued-blocker-${index}`,
		{ query: `queued blocker ${index}`, provider: "brave", workflow: "none", includeContent: true },
		controller.signal,
		undefined,
		runtime.context,
	));
	await Promise.all(blockerStarted.map(({ promise }) => promise));

	const queuedController = new AbortController();
	const callerReason = new Error("cancel queued content");
	const queuedExecution = tool(runtime.extension, "web_search").execute(
		"queued-cancel-search",
		{ query: "queued cancellation", provider: "brave", workflow: "none", includeContent: true },
		queuedController.signal,
		undefined,
		runtime.context,
	);
	try {
		await new Promise((resolve) => setImmediate(resolve));
		queuedController.abort(callerReason);
		await assert.rejects(settlesWithin(queuedExecution, "queued content cancellation"), (error) => error === callerReason);
		assert.deepEqual(runtime.entries, []);
	} finally {
		for (const controller of blockerControllers) controller.abort(new Error("release queued blocker"));
		for (const gate of blockerGates) gate.resolve(new Response("released", { status: 200 }));
		await Promise.allSettled([...blockers, queuedExecution]);
	}
});

test("caller cancellation closes a direct HTTP body before tool settlement", async () => {
	const runtime = await createRuntime("caller-cancel-body");
	const controller = new AbortController();
	const callerReason = new Error("caller cancelled body");
	const updates = [];
	let bodyCancelled = false;
	let requestsAfterCancellation = 0;
	let cancelled = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (cancelled) requestsAfterCancellation += 1;
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) return braveSearchResponse(["http://127.0.0.1/direct"]);
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/direct") return new Response("too short", { status: 200 });
		if (requestUrl === "http://127.0.0.1/direct") {
			const body = new ReadableStream({
				start(streamController) {
					streamController.enqueue(new TextEncoder().encode("partial body"));
				},
				cancel() {
					bodyCancelled = true;
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const activityShortcut = runtime.extension.shortcuts.get("ctrl+shift+w");
	assert.ok(activityShortcut, "activity shortcut should be registered");
	await activityShortcut.handler(runtime.context);
	const execution = tool(runtime.extension, "web_search").execute(
		"cancel-body-search",
		{ query: "cancel direct body", provider: "brave", workflow: "none", includeContent: true },
		controller.signal,
		(update) => updates.push(update),
		runtime.context,
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	cancelled = true;
	controller.abort(callerReason);
	await assert.rejects(settlesWithin(execution, "direct body caller cancellation"), (error) => error === callerReason);
	assert.equal(bodyCancelled, true, "the response body must close before web_search settles");
	await assertNoLateEffects(runtime, updates, () => {}, () => requestsAfterCancellation);
});

test("caller cancellation settles when response-body cancellation never does", async () => {
	const runtime = await createRuntime("caller-cancel-non-settling-body");
	const controller = new AbortController();
	const callerReason = new Error("caller cancelled non-settling body");
	const cancellationStarted = deferred();
	const cancellationGate = deferred();
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/direct"]);
		}
		if (requestUrl === "http://127.0.0.1/direct") {
			return new Response(new ReadableStream({
				pull() {},
				cancel() {
					cancellationStarted.resolve();
					return cancellationGate.promise;
				},
			}), { status: 200, headers: { "content-type": "text/plain" } });
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const execution = tool(runtime.extension, "web_search").execute(
		"cancel-non-settling-body-search",
		{ query: "cancel non-settling body", provider: "brave", workflow: "none", includeContent: true },
		controller.signal,
		undefined,
		runtime.context,
	);
	try {
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort(callerReason);
		await settlesWithin(cancellationStarted.promise, "response-body cancellation start");
		await assert.rejects(settlesWithin(execution, "non-settling response-body cancellation"), (error) => error === callerReason);
		assert.deepEqual(runtime.entries, []);
	} finally {
		cancellationGate.resolve();
		await settlesWithin(execution.catch(() => {}), "non-settling response-body cleanup");
	}
});

test("caller cancellation already fired before body reading still closes the body", async () => {
	const runtime = await createRuntime("caller-cancel-before-body-reader");
	const controller = new AbortController();
	const callerReason = new Error("caller cancelled before body reader");
	const releaseBody = deferred();
	let bodyCancelled = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/direct"]);
		}
		if (requestUrl === "http://127.0.0.1/direct") {
			const body = new ReadableStream({
				async pull(streamController) {
					await releaseBody.promise;
					streamController.close();
				},
				cancel() {
					bodyCancelled = true;
				},
			});
			const response = new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
			Object.defineProperty(response, "body", {
				get() {
					controller.abort(callerReason);
					return body;
				},
			});
			return response;
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const execution = tool(runtime.extension, "web_search").execute(
		"cancel-before-body-reader-search",
		{ query: "cancel before body reader", provider: "brave", workflow: "none", includeContent: true },
		controller.signal,
		undefined,
		runtime.context,
	);
	try {
		await assert.rejects(settlesWithin(execution, "pre-fired body cancellation"), (error) => error === callerReason);
		assert.equal(bodyCancelled, true, "the response body must close before web_search settles");
		assert.deepEqual(runtime.entries, []);
	} finally {
		releaseBody.resolve();
		await settlesWithin(execution.catch(() => {}), "pre-fired body test cleanup");
	}
});

test("fallback settles when failed-body cancellation never does", async () => {
	const runtime = await createRuntime("failed-body-fallback");
	const cancellationStarted = deferred();
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) return braveSearchResponse(["http://127.0.0.1/direct"]);
		if (requestUrl === "http://127.0.0.1/direct") {
			const body = new ReadableStream({
				start(streamController) {
					streamController.enqueue(new TextEncoder().encode("upstream failure"));
				},
				cancel() {
					cancellationStarted.resolve();
					return new Promise(() => {});
				},
			});
			return new Response(body, { status: 502 });
		}
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/direct") {
			return jinaResponse("http://127.0.0.1/direct", "Fallback content");
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const execution = tool(runtime.extension, "web_search").execute(
		"failed-body-fallback-search",
		{ query: "failed direct body", provider: "brave", workflow: "none", includeContent: true },
		undefined,
		undefined,
		runtime.context,
	);
	const result = await Promise.race([
		execution,
		new Promise((_resolve, reject) => setTimeout(() => reject(new Error("failed-body fallback did not settle")), 300)),
	]);

	await settlesWithin(cancellationStarted.promise, "failed-body cancellation start");
	assert.equal(result.details.contentReady, 1);
});

test("registered web_search cancels a non-settling YouTube thumbnail", async () => {
	const runtime = await createRuntime("youtube-thumbnail-cancellation");
	const controller = new AbortController();
	const callerReason = new Error("cancel YouTube thumbnail");
	const thumbnailStarted = deferred();
	const thumbnailGate = deferred();
	const originalGeminiKey = process.env.GEMINI_API_KEY;
	process.env.GEMINI_API_KEY = "youtube-terminal-test-key";
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/youtube.com/watch?v=dQw4w9WgXcQ"]);
		}
		if (requestUrl.startsWith("https://generativelanguage.googleapis.com/")) {
			return new Response(JSON.stringify({
				candidates: [{ content: { parts: [{ text: "# Video transcript\nUseful content" }] } }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (requestUrl.startsWith("https://img.youtube.com/")) {
			thumbnailStarted.resolve();
			return thumbnailGate.promise;
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const execution = tool(runtime.extension, "web_search").execute(
		"cancel-youtube-thumbnail",
		{ query: "cancel YouTube thumbnail", provider: "brave", workflow: "none", includeContent: true },
		controller.signal,
		undefined,
		runtime.context,
	);
	try {
		await settlesWithin(thumbnailStarted.promise, "registered YouTube thumbnail start");
		controller.abort(callerReason);
		await assert.rejects(settlesWithin(execution, "registered YouTube thumbnail cancellation"), (error) => error === callerReason);
		assert.deepEqual(runtime.entries, []);
	} finally {
		thumbnailGate.resolve(new Response("late thumbnail", { status: 200 }));
		await settlesWithin(execution.catch(() => {}), "registered YouTube thumbnail cleanup");
		if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
		else process.env.GEMINI_API_KEY = originalGeminiKey;
	}
});

test("terminal content closes oversized and unsupported response bodies", async () => {
	const runtime = await createRuntime("discarded-response-bodies");
	const cancelledBodies = new Set();
	const discardedResponse = (name, headers) => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(name));
		},
		cancel() {
			cancelledBodies.add(name);
		},
	}), { status: 200, headers });
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["http://127.0.0.1/oversized", "http://127.0.0.1/image"]);
		}
		if (requestUrl === "http://127.0.0.1/oversized") {
			return discardedResponse("oversized", { "content-type": "text/plain", "content-length": String(6 * 1024 * 1024) });
		}
		if (requestUrl === "http://127.0.0.1/image") {
			return discardedResponse("unsupported", { "content-type": "image/png" });
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const result = await tool(runtime.extension, "web_search").execute(
		"discarded-response-bodies-search",
		{ query: "discarded response bodies", provider: "brave", workflow: "none", includeContent: true },
		undefined,
		undefined,
		runtime.context,
	);

	assert.equal(result.details.contentReady, 0);
	assert.equal(result.details.contentErrors, 2);
	assert.deepEqual(cancelledBodies, new Set(["oversized", "unsupported"]));
});

test("caller cancellation terminates a waiter on another search's cached GitHub clone", async () => {
	const runtime = await createRuntime("github-clone-waiter-cancel");
	const ownerController = new AbortController();
	const waiterController = new AbortController();
	const waiterReason = new Error("cancel cached clone waiter");
	const fakeBin = await mkdtemp(join(tmpdir(), "pi-web-access-fake-gh-waiter-"));
	const pidFile = join(fakeBin, "gh.pid");
	const ghPath = join(fakeBin, "gh");
	await writeFile(ghPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nif (process.argv.includes("--version")) { console.log("gh version test"); process.exit(0); }\nif (process.argv.includes("api")) { console.log("1"); process.exit(0); }\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
	await chmod(ghPath, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["https://github.com/example/cached-cancellation-repository"]);
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	let childPid;
	const ownerExecution = tool(runtime.extension, "web_search").execute(
		"github-clone-owner",
		{ query: "GitHub clone owner", provider: "brave", workflow: "none", includeContent: true },
		ownerController.signal,
		undefined,
		runtime.context,
	);
	let waiterExecution;
	try {
		childPid = Number(await waitForFile(pidFile, "cached clone owner pid"));
		waiterExecution = tool(runtime.extension, "web_search").execute(
			"github-clone-waiter",
			{ query: "GitHub clone waiter", provider: "brave", workflow: "none", includeContent: true },
			waiterController.signal,
			undefined,
			runtime.context,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		waiterController.abort(waiterReason);
		await assert.rejects(settlesWithin(waiterExecution, "cached clone waiter cancellation"), (error) => error === waiterReason);
	} finally {
		ownerController.abort(new Error("release cached clone owner"));
		if (childPid && isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
		process.env.PATH = originalPath;
		await Promise.allSettled([ownerExecution, waiterExecution]);
	}
});

test("caller cancellation terminates GitHub CLI work before tool settlement", async () => {
	const runtime = await createRuntime("github-cli-cancel");
	const controller = new AbortController();
	const callerReason = new Error("cancel GitHub CLI");
	const fakeBin = await mkdtemp(join(tmpdir(), "pi-web-access-fake-gh-"));
	const pidFile = join(fakeBin, "gh.pid");
	const ghPath = join(fakeBin, "gh");
	await writeFile(ghPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nif (process.argv.includes("--version")) { console.log("gh version test"); process.exit(0); }\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
	await chmod(ghPath, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl.startsWith("https://api.search.brave.com/res/v1/web/search")) {
			return braveSearchResponse(["https://github.com/example/slow-repository"]);
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const activityShortcut = runtime.extension.shortcuts.get("ctrl+shift+w");
	assert.ok(activityShortcut, "activity shortcut should be registered");
	await activityShortcut.handler(runtime.context);
	let childPid;
	let childAliveAtSettlement = false;
	let widgetUpdatesAtSettlement = 0;
	let widgetUpdatesAfterChildExit = 0;
	try {
		const execution = tool(runtime.extension, "web_search").execute(
			"github-cli-cancel-search",
			{ query: "GitHub repository", provider: "brave", workflow: "none", includeContent: true },
			controller.signal,
			undefined,
			runtime.context,
		);
		childPid = Number(await waitForFile(pidFile, "fake gh pid"));
		controller.abort(callerReason);
		await assert.rejects(settlesWithin(execution, "GitHub CLI cancellation"), (error) => error === callerReason);
		childAliveAtSettlement = isProcessAlive(childPid);
		widgetUpdatesAtSettlement = runtime.widgetUpdates.length;
	} finally {
		if (childPid && isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
		process.env.PATH = originalPath;
		await new Promise((resolve) => setTimeout(resolve, 50));
		widgetUpdatesAfterChildExit = runtime.widgetUpdates.length;
	}

	assert.equal(childAliveAtSettlement, false, "GitHub CLI process must exit before web_search settles");
	assert.equal(widgetUpdatesAfterChildExit, widgetUpdatesAtSettlement, "GitHub cleanup must not update the widget after settlement");
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

test("mixed inline, retrieved, failed, timed-out, and duplicate sources share one ordered continuation", async () => {
	const runtime = await createRuntime("mixed-outcomes");
	process.env.EXA_API_KEY = "exa-test-key";
	const deadline = new AbortController();
	const timeoutFetch = deferred();
	const originalTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => deadline.signal;
	const contentRequests = [];
	let requestsAfterDeadline = 0;
	let deadlinePassed = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (deadlinePassed) requestsAfterDeadline += 1;
		if (requestUrl === "https://api.exa.ai/search") {
			return new Response(JSON.stringify({ results: [
				{ title: "Inline", url: "https://example.com/inline", text: "# Inline\nProvider supplied content" },
				{ title: "Success", url: "http://127.0.0.1/success" },
				{ title: "Failure", url: "http://127.0.0.1/failure" },
				{ title: "Timeout", url: "http://127.0.0.1/timeout" },
				{ title: "Success duplicate", url: "http://127.0.0.1/success#duplicate" },
			] }), { status: 200, headers: { "content-type": "application/json" } });
		}
		contentRequests.push(requestUrl);
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/success") return jinaResponse("http://127.0.0.1/success", "Success");
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/failure") return new Response("failed", { status: 502, statusText: "Bad Gateway" });
		if (requestUrl === "http://127.0.0.1/failure") return new Response("failed", { status: 502, statusText: "Bad Gateway" });
		if (requestUrl === "https://r.jina.ai/http://127.0.0.1/timeout") return timeoutFetch.promise;
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	try {
		const execution = tool(runtime.extension, "web_search").execute(
			"mixed-outcome-search",
			{ query: "mixed outcomes", provider: "exa", workflow: "none", includeContent: true },
			undefined,
			undefined,
			runtime.context,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		deadlinePassed = true;
		deadline.abort(new DOMException("deadline", "TimeoutError"));
		const result = await settlesWithin(execution, "mixed content deadline");

		assert.equal(contentRequests.some((url) => url.includes("example.com/inline")), false);
		assert.equal(contentRequests.filter((url) => url === "https://r.jina.ai/http://127.0.0.1/success").length, 1);
		assert.equal(result.details.contentReady, 2);
		assert.equal(result.details.contentErrors, 2);
		const inline = await tool(runtime.extension, "get_search_content").execute("mixed-inline", { responseId: result.details.fetchId, urlIndex: 0 });
		const success = await tool(runtime.extension, "get_search_content").execute("mixed-success", { responseId: result.details.fetchId, urlIndex: 1 });
		const failure = await tool(runtime.extension, "get_search_content").execute("mixed-failure", { responseId: result.details.fetchId, urlIndex: 2 });
		const timeout = await tool(runtime.extension, "get_search_content").execute("mixed-timeout", { responseId: result.details.fetchId, urlIndex: 3 });
		const duplicate = await tool(runtime.extension, "get_search_content").execute("mixed-duplicate", { responseId: result.details.fetchId, urlIndex: 4 });
		assert.match(inline.content[0].text, /Provider supplied content/);
		assert.match(success.content[0].text, /# Success/);
		assert.match(failure.details.error, /HTTP 502/);
		assert.match(timeout.details.error, /timed out after 60 seconds/);
		assert.equal(duplicate.details.error, "Index out of range");
		assert.equal(runtime.sent.length, 0);
		await assertNoLateEffects(runtime, [], () => timeoutFetch.resolve(jinaResponse("http://127.0.0.1/timeout", "Timeout")), () => requestsAfterDeadline);
	} finally {
		AbortSignal.timeout = originalTimeout;
	}
});
