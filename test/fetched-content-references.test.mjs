import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentCore = dirname(codingAgentEntry);
const loaderUrl = pathToFileURL(join(codingAgentCore, "core/extensions/loader.js"));
const sessionManagerUrl = pathToFileURL(join(codingAgentCore, "core/session-manager.js"));
const { createExtensionRuntime, loadExtensionsCached } = await import(loaderUrl.href);
const { SessionManager } = await import(sessionManagerUrl.href);
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

async function loadRegisteredTools(branch = [], options = {}) {
	const configDir = options.configDir ?? await mkdtemp(join(tmpdir(), "pi-web-access-content-result-"));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify({ ssrf: { allowRanges: ["127.0.0.0/8"] } }));
	process.env.PI_CODING_AGENT_DIR = configDir;

	const runtime = createExtensionRuntime();
	const entries = [];
	const sent = [];
	runtime.appendEntry = options.sessionManager
		? options.sessionManager.appendCustomEntry.bind(options.sessionManager)
		: (customType, data) => {
			options.appendEntry?.(customType, data);
			entries.push({ customType, data });
		};
	runtime.sendMessage = (message, sendOptions) => {
		options.sendMessage?.(message, sendOptions);
		sent.push({ message, options: sendOptions });
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
		sessionManager: options.sessionManager ?? { getBranch: () => branch },
		ui: { setWidget() {}, notify() {} },
	};
	async function restoreSession(eventType, event) {
		for (const handler of extension.handlers.get(eventType) ?? []) {
			await handler(event, context);
		}
	}
	const startSession = () => restoreSession("session_start", { reason: "startup" });
	const treeSession = () => restoreSession("session_tree", {});
	if (options.startSession !== false) await startSession();

	return {
		entries,
		fetchContent: extension.tools.get("fetch_content")?.definition,
		getSearchContent: extension.tools.get("get_search_content")?.definition,
		sent,
		startSession,
		treeSession,
		webSearch: extension.tools.get("web_search")?.definition,
	};
}

async function createReadOnlySessionManager(cwd) {
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-web-access-session-"));
	const sessionManager = SessionManager.create(cwd, sessionDir);
	sessionManager.appendMessage({ role: "assistant", content: [] });
	const sessionFile = sessionManager.getSessionFile();
	assert.ok(sessionFile);
	await chmod(sessionFile, 0o400);
	return { sessionFile, sessionManager };
}

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
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

test("web search metadata explains how to retrieve stored search and content results", async () => {
	const tools = await loadRegisteredTools();
	assert.ok(tools.webSearch);

	for (const metadata of [tools.webSearch.description, tools.webSearch.promptSnippet]) {
		assert.match(metadata, /searchResultId/);
		assert.match(metadata, /contentResultId/);
		assert.match(metadata, /get_search_content/);
		assert.match(metadata, /resultId/);
	}
});

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
	assert.deepEqual(Object.keys(result.details).sort(), [
		"contentResultId",
		"duration",
		"frames",
		"hasImage",
		"imageCount",
		"prompt",
		"successful",
		"timestamp",
		"title",
		"totalChars",
		"truncated",
		"urlCount",
		"urls",
	]);
	assert.doesNotMatch(result.content.at(-1).text, /get_search_content/);
});

test("a truncated single-page fetch gives an exact resultId call that returns the complete page", async () => {
	const tools = await loadRegisteredTools();
	assert.ok(tools.fetchContent);
	assert.ok(tools.getSearchContent);
	assert.deepEqual(tools.getSearchContent.parameters.required, ["resultId"]);
	assert.deepEqual(Object.keys(tools.getSearchContent.parameters.properties).sort(), [
		"query",
		"queryIndex",
		"resultId",
		"url",
		"urlIndex",
	]);
	assert.equal(
		tools.getSearchContent.description,
		"Retrieve full content from a previous web_search or fetch_content call by passing its stored reference as resultId.",
	);
	assert.equal(
		tools.getSearchContent.promptSnippet,
		"Use after web_search/fetch_content when full stored content is needed via resultId plus query/url selectors.",
	);
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

test("a successful content result is not retrievable from another cached runtime", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-content-isolation-"));
	const owner = await loadRegisteredTools([], { configDir });
	assert.ok(owner.fetchContent);
	mockJinaPages({
		"http://127.0.0.1/private": {
			title: "Private page",
			content: "Owner-only marker.",
		},
	});
	const fetched = await owner.fetchContent.execute("fetch-private", {
		url: "http://127.0.0.1/private",
	});

	const other = await loadRegisteredTools([], { configDir, startSession: false });
	assert.ok(other.getSearchContent);
	const retrieved = await other.getSearchContent.execute("get-private", {
		resultId: fetched.details.contentResultId,
	});

	assert.equal(retrieved.details.error, "Not found");
	assert.equal(retrieved.details.resultId, fetched.details.contentResultId);
	assert.doesNotMatch(retrieved.content[0].text, /Owner-only marker/);
});

test("starting another cached runtime does not invalidate the owner's content result", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-content-lifetime-"));
	const owner = await loadRegisteredTools([], { configDir });
	assert.ok(owner.fetchContent);
	assert.ok(owner.getSearchContent);
	mockJinaPages({
		"http://127.0.0.1/owned": {
			title: "Owned page",
			content: "Still-owned marker.",
		},
	});
	const fetched = await owner.fetchContent.execute("fetch-owned", {
		url: "http://127.0.0.1/owned",
	});

	await loadRegisteredTools([], { configDir });
	const retrieved = await owner.getSearchContent.execute("get-owned", {
		resultId: fetched.details.contentResultId,
	});

	assert.equal(retrieved.details.error, undefined);
	assert.match(retrieved.content[0].text, /Still-owned marker/);
});

test("a failed content publication remains unavailable to a second runtime", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-content-publication-"));
	const { sessionFile, sessionManager } = await createReadOnlySessionManager(configDir);
	const failingRuntime = await loadRegisteredTools([], { configDir, sessionManager });
	assert.ok(failingRuntime.fetchContent);
	assert.ok(failingRuntime.getSearchContent);
	mockJinaPages({
		"http://127.0.0.1/unpublished": {
			title: "Unpublished page",
			content: "This content must remain private to the failed publication.",
		},
	});

	try {
		await assert.rejects(
			failingRuntime.fetchContent.execute("fetch-unpublished", { url: "http://127.0.0.1/unpublished" }),
			{ code: "EACCES" },
		);
	} finally {
		await chmod(sessionFile, 0o600);
	}
	const unpublishedEntry = sessionManager.getBranch().findLast(
		(entry) => entry.type === "custom" && entry.customType === "web-search-results",
	);
	assert.ok(unpublishedEntry);
	assert.equal(typeof unpublishedEntry.data.id, "string");
	const unpublishedResultId = unpublishedEntry.data.id;

	const restoredRuntime = await loadRegisteredTools([], { configDir, sessionManager });
	assert.ok(restoredRuntime.getSearchContent);
	const retrieved = await restoredRuntime.getSearchContent.execute("get-unpublished", {
		resultId: unpublishedResultId,
	});
	assert.equal(retrieved.details.error, "Not found");
	assert.equal(retrieved.details.resultId, unpublishedResultId);
	assert.match(retrieved.content[0].text, new RegExp(`resultId "${unpublishedResultId}"`));
});

test("a failed search publication remains unavailable to a second runtime", async () => {
	const previousBraveApiKey = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "brave-test-key";
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-search-publication-"));
	const { sessionFile, sessionManager } = await createReadOnlySessionManager(configDir);
	try {
		const tools = await loadRegisteredTools([], { configDir, sessionManager });
		assert.ok(tools.webSearch);
		assert.ok(tools.getSearchContent);
		globalThis.fetch = async (url) => {
			const requested = String(url);
			assert.match(requested, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search/);
			return new Response(JSON.stringify({
				web: {
					results: [{
						title: "Published only after session entry",
						url: "https://example.com/atomic-search",
						description: "Search result held until publication succeeds",
					}],
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		try {
			await assert.rejects(
				tools.webSearch.execute(
					"search-unpublished",
					{ query: "atomic search publication", provider: "brave", workflow: "none" },
					undefined,
					undefined,
					{ hasUI: false },
				),
				{ code: "EACCES" },
			);
		} finally {
			await chmod(sessionFile, 0o600);
		}
		const unpublishedEntry = sessionManager.getBranch().findLast(
			(entry) => entry.type === "custom" && entry.customType === "web-search-results",
		);
		assert.ok(unpublishedEntry);
		const unpublishedResultId = unpublishedEntry.data.id;
		assert.equal(typeof unpublishedResultId, "string");

		const restoredRuntime = await loadRegisteredTools([], { configDir, sessionManager });
		assert.ok(restoredRuntime.getSearchContent);
		const retrieved = await restoredRuntime.getSearchContent.execute("get-unpublished-search", {
			resultId: unpublishedResultId,
		});
		assert.equal(retrieved.details.error, "Not found");
		assert.equal(retrieved.details.resultId, unpublishedResultId);
	} finally {
		await chmod(sessionFile, 0o600);
		if (previousBraveApiKey === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = previousBraveApiKey;
	}
});

test("a failed inline search-content publication remains atomic in a second runtime", async () => {
	const previousTavilyApiKey = process.env.TAVILY_API_KEY;
	process.env.TAVILY_API_KEY = "tavily-test-key";
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-paired-publication-"));
	const { sessionFile, sessionManager } = await createReadOnlySessionManager(configDir);
	try {
		const tools = await loadRegisteredTools([], { configDir, sessionManager });
		assert.ok(tools.webSearch);
		assert.ok(tools.getSearchContent);
		globalThis.fetch = async (url) => {
			assert.equal(String(url), "https://api.tavily.com/search");
			return new Response(JSON.stringify({
				answer: "Atomic answer",
				results: [{
					title: "Atomic source",
					url: "https://example.com/atomic-inline",
					content: "Atomic snippet",
					raw_content: "Full content must publish with its search result.",
				}],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		try {
			await assert.rejects(
				tools.webSearch.execute(
					"search-inline-publication",
					{ query: "atomic inline publication", provider: "tavily", workflow: "none", includeContent: true },
					undefined,
					undefined,
					{ hasUI: false },
				),
				{ code: "EACCES" },
			);
		} finally {
			await chmod(sessionFile, 0o600);
		}
		const unpublishedEntry = sessionManager.getBranch().findLast(
			(entry) => entry.type === "custom" && entry.customType === "web-search-results",
		);
		assert.ok(unpublishedEntry);
		assert.equal(unpublishedEntry.data.type, "stored-result-publication");
		const attemptedResultIds = unpublishedEntry.data.records.map((record) => record.id);
		assert.equal(attemptedResultIds.length, 2);

		const restoredRuntime = await loadRegisteredTools([], { configDir, sessionManager });
		assert.ok(restoredRuntime.getSearchContent);
		for (const resultId of attemptedResultIds) {
			const retrieved = await restoredRuntime.getSearchContent.execute(`get-${resultId}`, { resultId });
			assert.equal(retrieved.details.error, "Not found");
		}
	} finally {
		await chmod(sessionFile, 0o600);
		if (previousTavilyApiKey === undefined) delete process.env.TAVILY_API_KEY;
		else process.env.TAVILY_API_KEY = previousTavilyApiKey;
	}
});

test("a ready-notification failure does not report a successful background fetch as failed", async () => {
	const previousBraveApiKey = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "brave-test-key";
	const notificationAttempted = deferred();
	const attemptedMessages = [];
	try {
		const tools = await loadRegisteredTools([], {
			sendMessage(message) {
				attemptedMessages.push(message);
				if (attemptedMessages.length === 1) {
					notificationAttempted.resolve();
					throw new Error("ready notification transport failed");
				}
			},
		});
		assert.ok(tools.webSearch);
		assert.ok(tools.getSearchContent);
		globalThis.fetch = async (url) => {
			const requested = String(url);
			if (requested.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({
					web: { results: [{
						title: "Background source",
						url: "http://127.0.0.1/notification-source",
						description: "Stored before notification",
					}] },
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (requested === "http://127.0.0.1/notification-source") {
				return new Response(
					`<html><head><title>Notification source</title></head><body><main><p>${"Successfully stored marker. ".repeat(40)}</p></main></body></html>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			}
			if (requested === "https://r.jina.ai/http://127.0.0.1/notification-source") {
				return new Response(
					"Title: Notification source\nURL Source: http://127.0.0.1/notification-source\nMarkdown Content:\nSuccessfully stored marker.",
					{ status: 200, headers: { "content-type": "text/markdown" } },
				);
			}
			throw new Error(`Unexpected fetch: ${requested}`);
		};

		const searched = await tools.webSearch.execute(
			"search-notification-failure",
			{ query: "notification failure", provider: "brave", workflow: "none", includeContent: true },
			undefined,
			undefined,
			{ hasUI: false },
		);
		await notificationAttempted.promise;
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(attemptedMessages.length, 1);
		assert.doesNotMatch(attemptedMessages[0].content, /Content fetch failed/);
		assert.equal(tools.sent.length, 0);
		const retrieved = await tools.getSearchContent.execute("get-notified-content", {
			resultId: searched.details.contentResultId,
		});
		assert.equal(retrieved.details.error, undefined);
		assert.match(retrieved.content[0].text, /Successfully stored marker/);
	} finally {
		if (previousBraveApiKey === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = previousBraveApiKey;
	}
});

test("a failed background content publication remains unavailable to a second runtime", async () => {
	const previousBraveApiKey = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "brave-test-key";
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-background-publication-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-web-access-session-"));
	const sessionManager = SessionManager.create(configDir, sessionDir);
	sessionManager.appendMessage({ role: "assistant", content: [] });
	const sessionFile = sessionManager.getSessionFile();
	assert.ok(sessionFile);
	const failureNotified = deferred();
	try {
		const tools = await loadRegisteredTools([], {
			configDir,
			sessionManager,
			sendMessage(message) {
				if (/Content fetch failed/.test(message.content)) failureNotified.resolve(message);
			},
		});
		assert.ok(tools.webSearch);
		assert.ok(tools.getSearchContent);
		globalThis.fetch = async (url) => {
			const requested = String(url);
			if (requested.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({
					web: { results: [{
						title: "Background publication source",
						url: "http://127.0.0.1/background-publication",
						description: "The search remains published if content publication fails",
					}] },
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (requested === "http://127.0.0.1/background-publication") {
				await chmod(sessionFile, 0o400);
				return new Response(
					`<html><head><title>Background publication</title></head><body><main><p>${"Failed publication marker. ".repeat(40)}</p></main></body></html>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				);
			}
			throw new Error(`Unexpected fetch: ${requested}`);
		};

		const searched = await tools.webSearch.execute(
			"search-background-publication",
			{ query: "background publication", provider: "brave", workflow: "none", includeContent: true },
			undefined,
			undefined,
			{ hasUI: false },
		);
		const failureMessage = await failureNotified.promise;
		assert.match(failureMessage.content, new RegExp(searched.details.contentResultId));
		assert.doesNotMatch(failureMessage.content, /Full page content now available/);

		await chmod(sessionFile, 0o600);
		const restoredRuntime = await loadRegisteredTools([], { configDir, sessionManager });
		assert.ok(restoredRuntime.getSearchContent);
		const rejectedContent = await restoredRuntime.getSearchContent.execute("get-rejected-background-content", {
			resultId: searched.details.contentResultId,
		});
		assert.equal(rejectedContent.details.error, "Not found");
		const restoredSearch = await restoredRuntime.getSearchContent.execute("get-restored-background-search", {
			resultId: searched.details.searchResultId,
			queryIndex: 0,
		});
		assert.equal(restoredSearch.details.error, undefined);
		assert.match(restoredSearch.content[0].text, /Background publication source/);
	} finally {
		await chmod(sessionFile, 0o600);
		if (previousBraveApiKey === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = previousBraveApiKey;
	}
});

test("a failed primary search publication starts no background content work", async () => {
	const previousBraveApiKey = process.env.BRAVE_API_KEY;
	process.env.BRAVE_API_KEY = "brave-test-key";
	const publicationError = new Error("primary search publication failed");
	const contentGate = deferred();
	let contentRequests = 0;
	let attemptedContentResultId;
	try {
		const tools = await loadRegisteredTools([], {
			appendEntry(_customType, data) {
				if (data.type === "search") throw publicationError;
				attemptedContentResultId = data.id;
			},
		});
		assert.ok(tools.webSearch);
		assert.ok(tools.getSearchContent);
		globalThis.fetch = async (url) => {
			const requested = String(url);
			if (requested.startsWith("https://api.search.brave.com/res/v1/web/search")) {
				return new Response(JSON.stringify({
					web: {
						results: [{
							title: "Background source",
							url: "http://127.0.0.1/background-source",
							description: "Must not be fetched before primary publication",
						}],
					},
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (requested === "https://r.jina.ai/http://127.0.0.1/background-source") {
				contentRequests += 1;
				await contentGate.promise;
				return new Response(
					"Title: Background source\nURL Source: http://127.0.0.1/background-source\nMarkdown Content:\nForbidden late content",
					{ status: 200, headers: { "content-type": "text/markdown" } },
				);
			}
			throw new Error(`Unexpected fetch: ${requested}`);
		};

		await assert.rejects(
			tools.webSearch.execute(
				"search-with-unpublished-content",
				{ query: "publication ordering", provider: "brave", workflow: "none", includeContent: true },
				undefined,
				undefined,
				{ hasUI: false },
			),
			publicationError,
		);
		contentGate.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(contentRequests, 0);
		assert.deepEqual(tools.entries, []);
		assert.deepEqual(tools.sent, []);
		assert.equal(attemptedContentResultId, undefined);
	} finally {
		contentGate.resolve();
		if (previousBraveApiKey === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = previousBraveApiKey;
	}
});

test("a stored search-content publication restores both records or neither", async () => {
	const now = Date.now();
	const searchResultId = "expired-paired-search";
	const contentResultId = "fresh-paired-content";
	const restored = await loadRegisteredTools([{
		type: "custom",
		customType: "web-search-results",
		data: {
			type: "stored-result-publication",
			records: [
				{
					id: searchResultId,
					type: "search",
					timestamp: now - (60 * 60 * 1000) - 1,
					queries: [{ query: "paired query", answer: "paired answer", results: [], error: null }],
				},
				{
					id: contentResultId,
					type: "fetch",
					timestamp: now,
					urls: [{
						url: "https://example.com/paired",
						title: "Paired content",
						content: "This half must not restore alone.",
						error: null,
					}],
				},
			],
		},
	}]);
	assert.ok(restored.getSearchContent);

	for (const resultId of [searchResultId, contentResultId]) {
		const result = await restored.getSearchContent.execute(`get-${resultId}`, { resultId });
		assert.equal(result.details.error, "Not found");
		assert.equal(result.details.resultId, resultId);
	}
});

test("malformed restored records are ignored", async () => {
	const malformedRecords = [
		{
			id: "malformed-null-content",
			type: "fetch",
			timestamp: Date.now(),
			urls: [null],
		},
		{
			id: "malformed-content-error",
			type: "fetch",
			timestamp: Date.now(),
			urls: [{ url: "https://example.com", title: "Example", content: "Body", error: 42 }],
		},
		{
			id: "malformed-search-result",
			type: "search",
			timestamp: Date.now(),
			queries: [{ query: "example", answer: "Answer", results: [null], error: null }],
		},
		{
			id: "malformed-timestamp",
			type: "fetch",
			timestamp: "now",
			urls: [],
		},
	];
	const restored = await loadRegisteredTools(malformedRecords.map((data) => ({
		type: "custom",
		customType: "web-search-results",
		data,
	})));
	assert.ok(restored.getSearchContent);

	for (const { id: resultId } of malformedRecords) {
		const result = await restored.getSearchContent.execute(`get-${resultId}`, { resultId });
		assert.equal(result.details.error, "Not found");
		assert.equal(result.details.resultId, resultId);
	}
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
	assert.deepEqual(
		fetchedText.split("\n").map((line) => line.trim()).filter((line) => /[A-Za-z]+Id:/.test(line)),
		[`contentResultId: ${fetched.details.contentResultId}`],
	);

	const failed = await tools.fetchContent.execute("fetch-render-error", { url: "not-a-url" });
	const failedText = renderText(tools.fetchContent.renderResult(failed, { expanded: true, isPartial: false }, plainTheme));
	assert.deepEqual(
		failedText.split("\n").map((line) => line.trim()).filter((line) => /[A-Za-z]+Id:/.test(line)),
		[`contentResultId: ${failed.details.contentResultId}`],
	);

	const many = await tools.fetchContent.execute("fetch-render-many", { urls: [firstUrl, secondUrl] });
	const retrievalCall = renderText(tools.getSearchContent.renderCall({ resultId: many.details.contentResultId }, plainTheme));
	assert.match(retrievalCall, new RegExp(`resultId=${many.details.contentResultId}`));
	const choices = await tools.getSearchContent.execute("render-list", { resultId: many.details.contentResultId });
	const choicesText = renderText(tools.getSearchContent.renderResult(choices, { expanded: true, isPartial: false }, plainTheme));
	assert.deepEqual(
		choicesText.split("\n").map((line) => line.trim()).filter((line) => /[A-Za-z]+Id:/.test(line)),
		[`resultId: ${many.details.contentResultId} (2 URLs)`],
	);

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
