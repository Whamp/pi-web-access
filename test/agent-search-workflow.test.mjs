import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Check } from "typebox/value";

const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentDir = join(dirname(codingAgentEntry), "..");
const loaderUrl = pathToFileURL(join(dirname(codingAgentEntry), "core/extensions/loader.js"));
const compatUrl = pathToFileURL(join(codingAgentDir, "node_modules/@earendil-works/pi-ai/dist/compat.js"));
const { createExtensionRuntime, loadExtensionsCached } = await import(loaderUrl.href);
const { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders } = await import(compatUrl.href);
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalBraveKey = process.env.BRAVE_API_KEY;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
const activeRuntimes = new Set();
const summaryProviderSource = "pi-web-access-agent-workflow-test";

function restoreEnvironmentVariable(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test.afterEach(async () => {
	for (const runtime of activeRuntimes) await runtime.shutdown();
	activeRuntimes.clear();
	unregisterApiProviders(summaryProviderSource);
	restoreEnvironmentVariable("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnvironmentVariable("BRAVE_API_KEY", originalBraveKey);
	restoreEnvironmentVariable("OPENAI_API_KEY", originalOpenAIKey);
	globalThis.fetch = originalFetch;
});

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

const unavailableModelRegistry = {
	getAvailable: () => [],
	find: () => undefined,
	getApiKeyAndHeaders: async () => ({ ok: false }),
};

async function loadRuntime(config = {}, modelRegistry = unavailableModelRegistry) {
	const configDir = await mkdtemp(join(tmpdir(), "pi-web-access-agent-workflow-"));
	await writeFile(join(configDir, "web-search.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.env.BRAVE_API_KEY = "brave-test-key";
	delete process.env.OPENAI_API_KEY;

	const runtime = createExtensionRuntime();
	const notifications = [];
	const sent = [];
	const entries = [];
	runtime.sendMessage = (message, options) => sent.push({ message, options });
	runtime.appendEntry = (customType, data) => entries.push({ customType, data });
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
		modelRegistry,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
		ui: { setWidget() {}, notify(message, level) { notifications.push({ message, level }); } },
	};
	const loadedRuntime = {
		extension,
		context,
		notifications,
		sent,
		entries,
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

test("registered schema accepts supported workflows and rejects unknown modes", async () => {
	const runtime = await loadRuntime();
	const tool = runtime.extension.tools.get("web_search")?.definition;
	assert.ok(tool);

	assert.equal(Check(tool.parameters, { query: "raw search", workflow: "none" }), true);
	assert.equal(Check(tool.parameters, { query: "summarized search", workflow: "auto-summary" }), true);
	assert.equal(Check(tool.parameters, { query: "legacy search", workflow: "summary-review" }), true);
	assert.equal(Check(tool.parameters, { query: "typo search", workflow: "auto-sumary" }), false);
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

test("auto-summary falls back for non-cancellation authentication errors containing abort", async () => {
	installSearchResponse();
	const summaryModel = { provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "Summary model" };
	const runtime = await loadRuntime({}, {
		getAvailable: () => [summaryModel],
		find: (provider, id) => provider === summaryModel.provider && id === summaryModel.id ? summaryModel : undefined,
		getApiKeyAndHeaders: async () => {
			throw new Error("credential lookup aborted by upstream");
		},
	});

	const result = await executeSearch(runtime, { query: "summary auth failure", provider: "brave", workflow: "auto-summary" });

	assert.equal(result.details.summary.workflow, "auto-summary");
	assert.equal(result.details.summary.fallbackUsed, true);
	assert.match(result.details.summary.fallbackReason, /credential lookup aborted by upstream/);
	assert.equal(runtime.entries.length, 1);
});

test("session replacement terminates provider authentication", async () => {
	const authStarted = deferred();
	const authGate = deferred();
	let authCalls = 0;
	const runtime = await loadRuntime({}, {
		getAvailable: () => [],
		find: () => undefined,
		getApiKeyAndHeaders: async () => {
			authCalls += 1;
			authStarted.resolve();
			return authGate.promise;
		},
	});
	const execution = executeSearch(runtime, { query: "cancel provider auth", provider: "openai", workflow: "none" });
	await authStarted.promise;

	for (const handler of runtime.extension.handlers.get("session_tree") ?? []) await handler({}, runtime.context);
	const result = await settlesWithin(execution, "provider authentication cancellation");
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "session-changed");
	assert.deepEqual(runtime.entries, []);

	authGate.resolve({ ok: false });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(authCalls, 1);
	assert.deepEqual(runtime.entries, []);
});

test("session replacement prevents publication during summary authentication", async () => {
	installSearchResponse();
	const authStarted = deferred();
	const authGate = deferred();
	const summaryModel = { provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "Summary model" };
	const runtime = await loadRuntime({}, {
		getAvailable: () => [summaryModel],
		find: (provider, id) => provider === summaryModel.provider && id === summaryModel.id ? summaryModel : undefined,
		getApiKeyAndHeaders: async () => {
			authStarted.resolve();
			return authGate.promise;
		},
	});
	const execution = executeSearch(runtime, { query: "cancel summary auth", provider: "brave", workflow: "auto-summary" });
	await authStarted.promise;

	for (const handler of runtime.extension.handlers.get("session_tree") ?? []) await handler({}, runtime.context);
	const result = await settlesWithin(execution, "summary authentication cancellation");
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.cancelReason, "session-changed");
	assert.deepEqual(runtime.entries, []);

	authGate.resolve({ ok: false });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(runtime.entries, []);
});

async function assertSummaryStreamEndsBeforeLifecycleSettlement(eventName, label) {
	installSearchResponse();
	const summaryStarted = deferred();
	const summaryEnded = deferred();
	const summaryGate = deferred();
	const summaryModel = {
		provider: "openai-codex",
		id: "gpt-5.3-codex-spark",
		name: "Non-cooperative summary model",
		api: `non-cooperative-summary-${label}-test`,
	};
	registerApiProvider({
		api: summaryModel.api,
		stream() {
			const completion = createAssistantMessageEventStream();
			void (async () => {
				for await (const _event of completion) {
				}
				summaryEnded.resolve();
			})();
			void summaryGate.promise.then((message) => completion.end(message));
			summaryStarted.resolve();
			return completion;
		},
	}, summaryProviderSource);
	const runtime = await loadRuntime({}, {
		getAvailable: () => [summaryModel],
		find: (provider, id) => provider === summaryModel.provider && id === summaryModel.id ? summaryModel : undefined,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "summary-test-key" }),
	});
	const execution = executeSearch(runtime, { query: `cancel summary completion on ${label}`, provider: "brave", workflow: "auto-summary" });
	try {
		await settlesWithin(summaryStarted.promise, `${label} summary completion start`);
		for (const handler of runtime.extension.handlers.get(eventName) ?? []) {
			if (eventName === "session_tree") await handler({}, runtime.context);
			else await handler({});
		}
		const result = await settlesWithin(execution, `${label} summary completion cancellation`);
		assert.equal(result.details.cancelled, true);
		assert.equal(result.details.cancelReason, "session-changed");
		await settlesWithin(summaryEnded.promise, `${label} summary stream disposal`);
		assert.deepEqual(runtime.entries, []);
		assert.deepEqual(runtime.sent, []);
	} finally {
		const entryCount = runtime.entries.length;
		const sentCount = runtime.sent.length;
		summaryGate.resolve({ stopReason: "stop", content: [] });
		await settlesWithin(execution.catch(() => {}), `${label} summary test cleanup`);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(runtime.entries.length, entryCount, "late summary completion must not publish an entry");
		assert.equal(runtime.sent.length, sentCount, "late summary completion must not send a message");
	}
}

test("session replacement terminates non-cooperative summary completion", async () => {
	await assertSummaryStreamEndsBeforeLifecycleSettlement("session_tree", "session replacement");
});

test("shutdown terminates non-cooperative summary completion", async () => {
	await assertSummaryStreamEndsBeforeLifecycleSettlement("session_shutdown", "shutdown");
});

test("/websearch explicitly starts the curator", async () => {
	const runtime = await loadRuntime();
	const command = runtime.extension.commands.get("websearch")?.handler;
	assert.ok(command);

	await command("", runtime.context);
	assert.deepEqual(runtime.notifications[0], { message: "Opening web search curator...", level: "info" });
	await runtime.shutdown();
});
