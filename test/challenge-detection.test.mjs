import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;
const lookupSource = `async () => [{ address: "93.184.216.34", family: 4 }]`;

async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-challenge-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config));
	return home;
}

function runChild(script, home, env = {}) {
	return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
		cwd: new URL("..", import.meta.url),
		encoding: "utf8",
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GEMINI_API_KEY: "",
			GOOGLE_GEMINI_BASE_URL: "",
			CLOUDFLARE_API_KEY: "",
			PARALLEL_API_KEY: "",
			...env,
		},
	});
}

test("fetch_content continues to Jina after the ScrapingCourse Cloudflare challenge", async () => {
	const challenge = await readFile(new URL("./fixtures/scrapingcourse-cloudflare-challenge.html", import.meta.url), "utf8");
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://www.scrapingcourse.com/cloudflare-challenge") {
				return new Response(${JSON.stringify(challenge)}, { headers: { "content-type": "text/html" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("Title: Recovered article\\nMarkdown Content:\\n\\n# Recovered article\\n\\n" + "Ordinary source content. ".repeat(30), { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://www.scrapingcourse.com/cloudflare-challenge", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://www.scrapingcourse.com/cloudflare-challenge",
		"https://r.jina.ai/https://www.scrapingcourse.com/cloudflare-challenge",
	]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Recovered article");
	assert.match(output.result.content, /Ordinary source content/);
});

test("fetch_content honors cf-mitigated challenge metadata before accepting the body", async () => {
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.test/protected") {
				return new Response("<html><body><article><h1>Wrong source</h1><p>" + "Substantive-looking challenge body. ".repeat(30) + "</p></article></body></html>", {
					headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
				});
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("Title: Resolved source\\nMarkdown Content:\\n\\n# Resolved source\\n\\n" + "Resolved ordinary content. ".repeat(30), { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.test/protected", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://example.test/protected",
		"https://r.jina.ai/https://example.test/protected",
	]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Resolved source");
});

test("fetch_content treats non-2xx challenge metadata as blocked after fallbacks", async () => {
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.test/non-2xx-challenge" || urlText.startsWith("https://r.jina.ai/")) {
				return new Response("challenge", {
					status: 403,
					headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
				});
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.test/non-2xx-challenge", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(
		{ calls: output.calls, error: output.result.error, content: output.result.content },
		{
			calls: [
				"https://example.test/non-2xx-challenge",
				"https://r.jina.ai/https://example.test/non-2xx-challenge",
			],
			error: "Requested content remained blocked by an anti-bot challenge.",
			content: "",
		},
	);
});

test("fetch_content rejects the ScrapingCourse generic anti-bot interstitial", async () => {
	const challenge = await readFile(new URL("./fixtures/scrapingcourse-antibot-challenge.html", import.meta.url), "utf8");
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://www.scrapingcourse.com/antibot-challenge") {
				return new Response(${JSON.stringify(challenge)}, { headers: { "content-type": "text/html" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("Title: Ordinary destination\\nMarkdown Content:\\n\\n# Ordinary destination\\n\\n" + "The requested article is now available. ".repeat(20), { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://www.scrapingcourse.com/antibot-challenge", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls.length, 2);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Ordinary destination");
});

test("fetch_content rejects an instruction-only challenge with a non-anchored title", async () => {
	const challenge = await readFile(new URL("./fixtures/instruction-only-challenge.html", import.meta.url), "utf8");
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.test/one-more-step") {
				return new Response(${JSON.stringify(challenge)}, { headers: { "content-type": "text/html" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("Title: Destination page\\nMarkdown Content:\\n\\n# Destination page\\n\\n" + "Ordinary destination text. ".repeat(25), { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.test/one-more-step", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls.length, 2);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Destination page");
});

test("fetch_content returns the blocked-content error when a Jina challenge exhausts eligible routes", async () => {
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.test/blocked") {
				return new Response("unavailable", { status: 503 });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("Title: Just a moment\\nMarkdown Content:\\n\\n# Just a moment\\n\\nPerforming security verification. Verify that you are not a bot. Complete the security check and please wait while we verify your browser.", { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.test/blocked", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://example.test/blocked",
		"https://r.jina.ai/https://example.test/blocked",
	]);
	assert.equal(output.result.error, "Requested content remained blocked by an anti-bot challenge.");
	assert.equal(output.result.content, "");
});

test("fetch_content rejects challenge instructions returned directly as Markdown", async () => {
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.test/direct-markdown") {
				return new Response("# Security check\\n\\nPerforming security verification. Verify that you are not a bot. Complete the security check and please wait while we verify your browser.", { headers: { "content-type": "text/markdown" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("Title: Markdown destination\\nMarkdown Content:\\n\\n# Markdown destination\\n\\n" + "Usable source content. ".repeat(30), { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.test/direct-markdown", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls.length, 2);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Markdown destination");
});

test("fetch_content continues to Gemini after Parallel returns challenge page content", async () => {
	const home = await createHome({ geminiApiKey: "gemini-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.test/parallel-blocked") {
				return new Response("unavailable", { status: 503 });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("unavailable", { status: 503 });
			}
			if (urlText === "https://api.parallel.ai/v1/extract") {
				const challenge = "# One more step\\n\\nVerify that you are not a bot. Complete the security check and please wait while we verify your browser. " + "This anti-bot verification page protects the destination from automated traffic. ".repeat(7);
				return new Response(JSON.stringify({ results: [{ url: "https://example.test/parallel-blocked", title: "One more step", full_content: challenge }] }), { headers: { "content-type": "application/json" } });
			}
			if (urlText.includes("generativelanguage.googleapis.com")) {
				return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Recovered by Gemini\\n\\n" + "Usable destination content. ".repeat(20) }] } }] }), { headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.test/parallel-blocked", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home, { PARALLEL_API_KEY: "pk_live_parallel_test_key" });

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.includes("https://api.parallel.ai/v1/extract"));
	assert.ok(output.calls.some(url => url.includes("generativelanguage.googleapis.com")));
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Recovered by Gemini");
});

for (const acceptedCase of [
	{
		name: "a substantive article discussing Cloudflare and CAPTCHA",
		fixture: "substantive-security-verification-article.html",
		title: "How anti-bot verification works",
	},
	{
		name: "resolved ordinary content that mentions an earlier verification screen",
		fixture: "resolved-ordinary-content.html",
		title: "Service restored",
	},
]) {
	test(`fetch_content accepts ${acceptedCase.name}`, async () => {
		const html = await readFile(new URL(`./fixtures/${acceptedCase.fixture}`, import.meta.url), "utf8");
		const home = await createHome();
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				return new Response(${JSON.stringify(html)}, { headers: { "content-type": "text/html" } });
			};
			const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractContent("https://example.test/article", undefined, { lookup: ${lookupSource} });
			console.log(JSON.stringify({ calls, result }));
		`, home);

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.calls, ["https://example.test/article"]);
		assert.equal(output.result.error, null);
		assert.equal(output.result.title, acceptedCase.title);
		assert.ok(output.result.content.length >= 500);
	});
}
