import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const parallelModuleUrl = new URL("../parallel.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-parallel-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"PARALLEL_API_KEY",
		"TAVILY_API_KEY",
		"EXA_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Parallel search and extraction share the persistent credential snapshot", async () => {
	const home = await createHome({ parallelApiKey: "pk_live_parallel_persistent_key" });
	const child = runChild(`
		const { createWebAccessConfiguration } = await import(new URL("../configuration.ts", ${JSON.stringify(import.meta.url)}));
		const { createParallelSearchProvider, extractWithParallel } = await import(${JSON.stringify(parallelModuleUrl)});
		const settings = createWebAccessConfiguration().current();
		const keys = [];
		globalThis.fetch = async (url, init) => {
			keys.push({ url: String(url), key: init.headers["x-api-key"] });
			if (String(url).endsWith("/search")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
			return new Response(JSON.stringify({ results: [{ url: "https://example.com", full_content: "x".repeat(600) }] }), { status: 200 });
		};
		const provider = createParallelSearchProvider(settings);
		await provider.search({ query: "shared key", options: {} });
		await extractWithParallel("https://example.com", undefined, {}, settings);
		console.log(JSON.stringify({ keys, eligibility: await provider.eligibility({}) }));
	`, { HOME: home, USERPROFILE: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.keys.map(call => call.key), ["pk_live_parallel_persistent_key", "pk_live_parallel_persistent_key"]);
	assert.deepEqual(output.eligibility, { eligible: true });
});

test("Parallel availability reads env and config keys while rejecting placeholders", async () => {
	const home = await createHome({ parallelApiKey: "your-key" });
	let child = runChild(`
		const { createWebAccessConfiguration } = await import(new URL("../configuration.ts", ${JSON.stringify(import.meta.url)}));
		const { isParallelAvailable } = await import(${JSON.stringify(parallelModuleUrl)});
		console.log(String(isParallelAvailable(createWebAccessConfiguration().current())));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "false");

	child = runChild(`
		const { createWebAccessConfiguration } = await import(new URL("../configuration.ts", ${JSON.stringify(import.meta.url)}));
		const { isParallelAvailable } = await import(${JSON.stringify(parallelModuleUrl)});
		console.log(String(isParallelAvailable(createWebAccessConfiguration().current())));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "pk_live_parallel_test_key" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");

	const configHome = await createHome({ parallelApiKey: "pk_live_parallel_config_key" });
	child = runChild(`
		const { createWebAccessConfiguration } = await import(new URL("../configuration.ts", ${JSON.stringify(import.meta.url)}));
		const { isParallelAvailable } = await import(${JSON.stringify(parallelModuleUrl)});
		console.log(String(isParallelAvailable(createWebAccessConfiguration().current())));
	`, { HOME: configHome, USERPROFILE: configHome, PARALLEL_API_KEY: "" });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "true");
});

test("explicit Parallel search routes through Parallel API and maps results", async () => {
	const home = await createHome({ provider: "parallel" });
	const child = runChild(`
		let captured = null;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({
				results: [{ title: "Parallel Docs", url: "https://docs.parallel.ai/search", excerpts: ["Parallel search excerpt"] }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("parallel search docs", { provider: "parallel", includeContent: true, numResults: 3, domainFilter: ["docs.parallel.ai", "-example.com"] });
		console.log(JSON.stringify({ captured, result }));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "pk_live_parallel_test_key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.captured.url, "https://api.parallel.ai/v1/search");
	assert.equal(output.captured.headers["x-api-key"], "pk_live_parallel_test_key");
	assert.deepEqual(output.captured.body.advanced_settings, {
		max_results: 3,
		source_policy: { include_domains: ["docs.parallel.ai"], exclude_domains: ["example.com"] },
	});
	assert.equal(output.result.provider, "parallel");
	assert.deepEqual(output.result.results, [{ title: "Parallel Docs", url: "https://docs.parallel.ai/search", snippet: "Parallel search excerpt" }]);
	assert.deepEqual(output.result.inlineContent, [{ url: "https://docs.parallel.ai/search", title: "Parallel Docs", content: "Parallel search excerpt", error: null }]);
});

test("compatibility search export honors current and legacy saved strict providers", async () => {
	for (const configKey of ["provider", "searchProvider"]) {
		const home = await createHome({ [configKey]: "brave" });
		const child = runChild(`
			let fetchCalls = 0;
			globalThis.fetch = async () => {
				fetchCalls += 1;
				return new Response(JSON.stringify({
					answer: "Exa fallback answer",
					citations: [{ title: "Exa", url: "https://exa.ai" }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			let outcome;
			try {
				const result = await search("strict saved provider");
				outcome = { result };
			} catch (error) {
				outcome = {
					errorName: error instanceof Error ? error.name : "unknown",
					provider: Reflect.get(error, "provider"),
					reason: Reflect.get(error, "reason"),
				};
			}
			console.log(JSON.stringify({ fetchCalls, outcome }));
		`, {
			HOME: home,
			USERPROFILE: home,
			EXA_API_KEY: "exa-test-key",
		});

		assert.equal(child.status, 0, `${configKey}: ${child.stderr}`);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.fetchCalls, 0, configKey);
		assert.deepEqual(output.outcome, {
			errorName: "ProviderIneligibleError",
			provider: "brave",
			reason: "Brave API key is not configured.",
		}, configKey);
	}
});

test("Parallel extract retries full content when excerpts are too short", async () => {
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(init.body) });
			if (calls.length === 1) {
				return new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "Short", excerpts: ["too short"] }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "Full", full_content: "# Full\\n" + "x".repeat(600) }] }), { status: 200 });
		};
		const { extractWithParallel } = await import(${JSON.stringify(parallelModuleUrl)});
		const result = await extractWithParallel("https://example.com");
		console.log(JSON.stringify({ calls, result }));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "pk_live_parallel_test_key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls.length, 2);
	assert.deepEqual(output.calls[1].body.advanced_settings, { full_content: true });
	assert.equal(output.result.title, "Full");
	assert.equal(output.result.error, null);
	assert.match(output.result.content, /^# Full/);
});

test("fetch_content continues to Gemini when Parallel extract fails", async () => {
	const home = await createHome({ geminiApiKey: "gemini-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.com/app") {
				return new Response("<html><body><script></script><script></script><script></script><script></script>Loading</body></html>", { status: 200, headers: { "content-type": "text/html" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("", { status: 503 });
			}
			if (urlText === "https://api.parallel.ai/v1/extract") {
				return new Response("parallel exploded", { status: 500 });
			}
			if (urlText.includes("generativelanguage.googleapis.com")) {
				return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Gemini fallback\\n" + "Recovered content ".repeat(20) }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		// Inject DNS so SSRF validation never depends on real resolution (which a
		// local fake-IP/TUN proxy would map into a blocked reserved range).
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const result = await extractContent("https://example.com/app", undefined, { lookup });
		console.log(JSON.stringify({ calls, result }));
	`, { HOME: home, USERPROFILE: home, PARALLEL_API_KEY: "pk_live_parallel_test_key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.includes("https://api.parallel.ai/v1/extract"));
	assert.ok(output.calls.some((url) => url.includes("generativelanguage.googleapis.com")));
	assert.equal(output.result.error, null);
	assert.match(output.result.content, /Gemini fallback/);
});
