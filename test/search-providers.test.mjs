import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;
const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;
const openaiModuleUrl = new URL("../openai-search.ts", import.meta.url).href;
const parallelModuleUrl = new URL("../parallel.ts", import.meta.url).href;
const perplexityModuleUrl = new URL("../perplexity.ts", import.meta.url).href;
const tavilyModuleUrl = new URL("../tavily.ts", import.meta.url).href;
const geminiModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env) {
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

test("Brave search applies domain filters in the query and returned results", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({
				web: { results: [
					{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", description: "repo" },
					{ title: "Gist", url: "https://gist.github.com/nicobailon/abc", description: "gist" },
					{ title: "Example", url: "https://example.com/nope", description: "example" },
				] },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { braveSearchProvider } = await import(${JSON.stringify(braveModuleUrl)});
		const result = await braveSearchProvider.search({ query: "sdk docs", options: {
			domainFilter: ["github.com", "-gist.github.com"],
			numResults: 2,
		} });
		const parsedUrl = new URL(capturedUrl);
		console.log(JSON.stringify({
			q: parsedUrl.searchParams.get("q"),
			count: parsedUrl.searchParams.get("count"),
			token: capturedHeaders["X-Subscription-Token"],
			results: result.results,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.q, /site:github\.com/);
	assert.match(output.q, /NOT site:gist\.github\.com/);
	assert.equal(output.count, "20");
	assert.equal(output.token, "brave-test-key");
	assert.deepEqual(output.results.map((result) => result.url), ["https://github.com/nicobailon/pi-web-access"]);
});

test("Tavily search uses bearer auth and maps filters/content", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-tavily-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "Tavily answer",
				results: [{
					title: "Tavily Docs",
					url: "https://docs.tavily.com/search",
					content: "Search docs snippet",
					raw_content: "# Tavily Docs\\nFull content",
				}],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { tavilySearchProvider } = await import(${JSON.stringify(tavilyModuleUrl)});
		const result = await tavilySearchProvider.search({ query: "tavily search docs", options: {
			domainFilter: ["https://docs.tavily.com/search", "-reddit.com"],
			recencyFilter: "week",
			numResults: 4,
			includeContent: true,
		} });
		console.log(JSON.stringify({ capturedUrl, capturedHeaders, capturedBody, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		TAVILY_API_KEY: "tvly-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedUrl, "https://api.tavily.com/search");
	assert.equal(output.capturedHeaders.Authorization, "Bearer tvly-test-key");
	assert.deepEqual(output.capturedBody, {
		query: "tavily search docs",
		search_depth: "basic",
		max_results: 4,
		include_answer: "basic",
		include_raw_content: "markdown",
		time_range: "week",
		include_domains: ["docs.tavily.com"],
		exclude_domains: ["reddit.com"],
	});
	assert.equal(output.result.answer, "Tavily answer");
	assert.deepEqual(output.result.results, [{ title: "Tavily Docs", url: "https://docs.tavily.com/search", snippet: "Search docs snippet" }]);
	assert.deepEqual(output.result.inlineContent, [{ url: "https://docs.tavily.com/search", title: "Tavily Docs", content: "# Tavily Docs\nFull content", error: null }]);
});

test("Exa direct API key ignores full legacy usage counter", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-paid-"));
	const child = runChild(`
		const dir = ${JSON.stringify(home)};
		const { readFileSync, writeFileSync } = await import("node:fs");
		writeFileSync(dir + "/web-search.json", JSON.stringify({ exaApiKey: "exa-paid-key" }));
		writeFileSync(dir + "/exa-usage.json", JSON.stringify({ month: new Date().toISOString().slice(0, 7), count: 1000 }));

		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({
				answer: "Paid Exa answer",
				citations: [{ title: "Exa Docs", url: "https://exa.ai/docs" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { exaSearchProvider } = await import(${JSON.stringify(exaModuleUrl)});
		const available = (await exaSearchProvider.eligibility({})).eligible;
		const result = await exaSearchProvider.search({ query: "paid exa query", options: {} });
		const usage = JSON.parse(readFileSync(dir + "/exa-usage.json", "utf8"));
		console.log(JSON.stringify({
			available,
			capturedUrl,
			apiKey: capturedHeaders["x-api-key"],
			result,
			usage,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, true);
	assert.equal(output.capturedUrl, "https://api.exa.ai/answer");
	assert.equal(output.apiKey, "exa-paid-key");
	assert.equal(output.result.answer, "Paid Exa answer");
	assert.deepEqual(output.result.results, [{ title: "Exa Docs", url: "https://exa.ai/docs", snippet: "" }]);
	assert.equal(output.usage.count, 1000);
});

test("OpenAI search requires web_search and maps domain filters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				output: [
					{
						type: "web_search_call",
						action: { sources: [{ title: "OpenAI Blog", url: "https://openai.com/blog?utm_source=openai" }] },
					},
					{
						type: "message",
						content: [{
							type: "output_text",
							text: "Answer from the web",
							annotations: [{
								type: "url_citation",
								start_index: 0,
								end_index: 6,
								url: "https://openai.com/docs?utm_source=openai",
								title: "OpenAI Docs",
							}],
						}],
					},
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { openAISearchProvider } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await openAISearchProvider.search({ query: "latest docs", options: {
			domainFilter: ["https://openai.com/docs", "-reddit.com"],
			numResults: 3,
		} });
		console.log(JSON.stringify({
			url: capturedUrl,
			authorization: capturedHeaders.Authorization,
			body: capturedBody,
			results: result.results,
			answer: result.answer,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		OPENAI_API_KEY: "sk-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.url, "https://api.openai.com/v1/responses");
	assert.equal(output.authorization, "Bearer sk-test-key");
	assert.equal(output.body.tool_choice, "required");
	assert.deepEqual(output.body.include, ["web_search_call.action.sources"]);
	assert.deepEqual(output.body.tools[0].filters, {
		allowed_domains: ["openai.com"],
		blocked_domains: ["reddit.com"],
	});
	assert.equal(output.answer, "Answer from the web");
	assert.deepEqual(output.results.map((result) => result.url), [
		"https://openai.com/docs",
		"https://openai.com/blog",
	]);
});

test("Parallel provider maps one mocked search request and response", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-parallel-provider-"));
	const child = runChild(`
		let capturedBody = null;
		globalThis.fetch = async (_url, init) => {
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				results: [{ title: "Parallel Docs", url: "https://docs.parallel.ai", excerpts: ["Parallel snippet"] }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { parallelSearchProvider } = await import(${JSON.stringify(parallelModuleUrl)});
		const result = await parallelSearchProvider.search({ query: "parallel docs", options: { numResults: 3 } });
		console.log(JSON.stringify({ capturedBody, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PARALLEL_API_KEY: "parallel-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedBody.objective, "parallel docs");
	assert.equal(output.capturedBody.advanced_settings.max_results, 3);
	assert.deepEqual(output.result.results, [{ title: "Parallel Docs", url: "https://docs.parallel.ai", snippet: "Parallel snippet" }]);
});

test("Perplexity provider maps one mocked search request and response", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-perplexity-provider-"));
	const child = runChild(`
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (_url, init) => {
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				choices: [{ message: { content: "Perplexity answer" } }],
				citations: [{ title: "Perplexity Docs", url: "https://docs.perplexity.ai" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { perplexitySearchProvider } = await import(${JSON.stringify(perplexityModuleUrl)});
		const result = await perplexitySearchProvider.search({ query: "perplexity docs", options: { recencyFilter: "month" } });
		console.log(JSON.stringify({ capturedHeaders, capturedBody, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PERPLEXITY_API_KEY: "perplexity-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.capturedHeaders.Authorization, "Bearer perplexity-test-key");
	assert.equal(output.capturedBody.search_recency_filter, "month");
	assert.equal(output.result.answer, "Perplexity answer");
	assert.deepEqual(output.result.results, [{ title: "Perplexity Docs", url: "https://docs.perplexity.ai", snippet: "" }]);
});

test("Gemini provider keeps API to Web behavior inside one logical attempt", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-provider-"));
	const child = runChild(`
		let calls = 0;
		let capturedUrl = "";
		globalThis.fetch = async (url) => {
			calls += 1;
			capturedUrl = String(url);
			return new Response(JSON.stringify({
				candidates: [{
					content: { parts: [{ text: "Gemini answer" }] },
					groundingMetadata: { groundingChunks: [{ web: { title: "Gemini Source", uri: "https://example.com/gemini" } }] },
				}],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const { geminiSearchProvider } = await import(${JSON.stringify(geminiModuleUrl)});
		const result = await geminiSearchProvider.search({ query: "gemini docs", options: {} });
		console.log(JSON.stringify({ calls, capturedUrl, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		GEMINI_API_KEY: "gemini-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls, 1);
	assert.match(output.capturedUrl, /generativelanguage\.googleapis\.com/);
	assert.equal(output.result.answer, "Gemini answer");
	assert.deepEqual(output.result.results, [{ title: "Gemini Source", url: "https://example.com/gemini", snippet: "" }]);
});

test("provider objects report eligibility and provider-specific ineligibility reasons", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-provider-eligibility-"));
	const child = runChild(`
		const modules = await Promise.all([
			import(${JSON.stringify(openaiModuleUrl)}),
			import(${JSON.stringify(exaModuleUrl)}),
			import(${JSON.stringify(braveModuleUrl)}),
			import(${JSON.stringify(parallelModuleUrl)}),
			import(${JSON.stringify(tavilyModuleUrl)}),
			import(${JSON.stringify(perplexityModuleUrl)}),
			import(${JSON.stringify(geminiModuleUrl)}),
		]);
		const providers = [
			modules[0].openAISearchProvider,
			modules[1].exaSearchProvider,
			modules[2].braveSearchProvider,
			modules[3].parallelSearchProvider,
			modules[4].tavilySearchProvider,
			modules[5].perplexitySearchProvider,
			modules[6].geminiSearchProvider,
		];
		const eligibility = [];
		for (const provider of providers) eligibility.push([provider.name, await provider.eligibility({})]);
		console.log(JSON.stringify(eligibility));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr);
	const eligibility = Object.fromEntries(JSON.parse(child.stdout.trim()));
	assert.deepEqual(eligibility.exa, { eligible: true });
	for (const name of ["openai", "brave", "parallel", "tavily", "perplexity", "gemini"]) {
		assert.equal(eligibility[name].eligible, false);
		assert.equal(typeof eligibility[name].reason, "string");
		assert.ok(eligibility[name].reason.length > 0);
	}
});
