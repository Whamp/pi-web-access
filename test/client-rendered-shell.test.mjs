import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createHome, lookupSource, runChild } from "../test-utils/challenge-harness.mjs";

const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;

test("fetch_content continues to Jina after native extraction returns a Client-rendered shell", async () => {
	const shell = await readFile(new URL("./fixtures/scrapingcourse-javascript-rendering.html", import.meta.url), "utf8");
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://www.scrapingcourse.com/javascript-rendering") {
				return new Response(${JSON.stringify(shell)}, { headers: { "content-type": "text/html" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("Title: Rendered products\\nMarkdown Content:\\n\\n# Rendered products\\n\\n" + "Recovered product names and prices. ".repeat(30), { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://www.scrapingcourse.com/javascript-rendering", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://www.scrapingcourse.com/javascript-rendering",
		"https://r.jina.ai/https://www.scrapingcourse.com/javascript-rendering",
	]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Rendered products");
	assert.match(output.result.content, /Recovered product names and prices/);
});

test("fetch_content returns a Client-rendered shell error when the native shell exhausts fallbacks", async () => {
	const shell = await readFile(new URL("./fixtures/scrapingcourse-javascript-rendering.html", import.meta.url), "utf8");
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://www.scrapingcourse.com/javascript-rendering") {
				return new Response(${JSON.stringify(shell)}, { headers: { "content-type": "text/html" } });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("unavailable", { status: 503 });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://www.scrapingcourse.com/javascript-rendering", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result.error, "Requested content remained a Client-rendered shell.");
	assert.equal(output.result.content, "");
});

test("fetch_content returns a Client-rendered shell error when a Jina shell exhausts fallbacks", async () => {
	const shell = await readFile(new URL("./fixtures/scrapingcourse-javascript-rendering-jina.md", import.meta.url), "utf8");
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://www.scrapingcourse.com/javascript-rendering") {
				return new Response("unavailable", { status: 503 });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response(${JSON.stringify(shell)}, { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://www.scrapingcourse.com/javascript-rendering", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, [
		"https://www.scrapingcourse.com/javascript-rendering",
		"https://r.jina.ai/https://www.scrapingcourse.com/javascript-rendering",
	]);
	assert.equal(output.result.error, "Requested content remained a Client-rendered shell.");
	assert.equal(output.result.content, "");
});

test("fetch_content classifies a standalone Jina blocker as a Client-rendered shell", async () => {
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://example.test/standalone-shell") {
				return new Response("unavailable", { status: 503 });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response("Title: Products\\nMarkdown Content:\\n\\n# Products\\n\\nEnable JavaScript to see products", { headers: { "content-type": "text/markdown" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.test/standalone-shell", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.result.error, "Requested content remained a Client-rendered shell.");
	assert.equal(output.result.content, "");
});

test("fetch_content continues to Gemini after Jina returns a Client-rendered shell", async () => {
	const shell = await readFile(new URL("./fixtures/scrapingcourse-javascript-rendering-jina.md", import.meta.url), "utf8");
	const home = await createHome({ geminiApiKey: "gemini-test-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText === "https://www.scrapingcourse.com/javascript-rendering") {
				return new Response("unavailable", { status: 503 });
			}
			if (urlText.startsWith("https://r.jina.ai/")) {
				return new Response(${JSON.stringify(shell)}, { headers: { "content-type": "text/markdown" } });
			}
			if (urlText.includes("generativelanguage.googleapis.com")) {
				return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "# Rendered by Gemini\\n\\n" + "Recovered product names and prices. ".repeat(20) }] } }] }), { headers: { "content-type": "application/json" } });
			}
			throw new Error("Unexpected fetch " + urlText);
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://www.scrapingcourse.com/javascript-rendering", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.ok(output.calls.some(url => url.includes("generativelanguage.googleapis.com")));
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Rendered by Gemini");
	assert.match(output.result.content, /Recovered product names and prices/);
});

test("fetch_content accepts a substantive article that quotes client-rendering blocker wording", async () => {
	const article = [
		"# Diagnosing storefront rendering",
		"",
		"Our storefront briefly displayed the message ‘Enable JavaScript to see products’ during a deployment.",
		"The message was a symptom, not the article’s instruction to the reader.",
		"This field report explains the cache invalidation failure, the deployment rollback, and the checks used to confirm that product data was restored.",
	].join("\n");
	const home = await createHome();
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			return new Response(${JSON.stringify(article)}, { headers: { "content-type": "text/markdown" } });
		};
		const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
		const result = await extractContent("https://example.test/rendering-report", undefined, { lookup: ${lookupSource} });
		console.log(JSON.stringify({ calls, result }));
	`, home);

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.calls, ["https://example.test/rendering-report"]);
	assert.equal(output.result.error, null);
	assert.equal(output.result.title, "Diagnosing storefront rendering");
	assert.equal(output.result.content, article);
});

for (const shellCase of [
	{
		name: "corroborated empty HTML structure without blocker text",
		url: "https://example.test/empty-catalog",
		html: `<html><head><title>Catalog</title></head><body><main><h1>Catalog</h1>${Array.from({ length: 8 }, () => '<a href=""><img src="" alt=""></a>').join("")}</main>${"<script>window.catalog = window.catalog || {};</script>".repeat(4)}</body></html>`,
	},
	{
		name: "a Client-rendered shell extracted from RSC data",
		url: "https://example.test/rsc-shell",
		html: `<html><head><title>Application</title></head><body><script>self.__next_f.push([1,${JSON.stringify(`1:${JSON.stringify(["$", "main", null, { children: [["$", "h1", null, { children: "Products" }], ["$", "p", null, { children: "Enable JavaScript to see products" }]] }])}`)}])</script></body></html>`,
	},
	{
		name: "a Client-rendered shell isolated by Readability",
		url: "https://example.test/readability-shell",
		html: `<html><head><title>Storefront</title></head><body><nav>${"Navigation, account, shipping, and policy information. ".repeat(20)}</nav><article><h1>Products</h1><p>Enable JavaScript to see products</p></article></body></html>`,
	},
]) {
	test(`fetch_content continues after ${shellCase.name}`, async () => {
		const home = await createHome();
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const urlText = String(url);
				calls.push(urlText);
				if (urlText === ${JSON.stringify(shellCase.url)}) {
					return new Response(${JSON.stringify(shellCase.html)}, { headers: { "content-type": "text/html" } });
				}
				if (urlText.startsWith("https://r.jina.ai/")) {
					return new Response("Title: Recovered source\\nMarkdown Content:\\n\\n# Recovered source\\n\\n" + "Usable rendered content. ".repeat(30), { headers: { "content-type": "text/markdown" } });
				}
				throw new Error("Unexpected fetch " + urlText);
			};
			const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractContent(${JSON.stringify(shellCase.url)}, undefined, { lookup: ${lookupSource} });
			console.log(JSON.stringify({ calls, result }));
		`, home);

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.calls, [shellCase.url, `https://r.jina.ai/${shellCase.url}`]);
		assert.equal(output.result.error, null);
		assert.equal(output.result.title, "Recovered source");
	});
}

for (const acceptedCase of [
	{
		name: "a complete sparse page",
		title: "Service status",
		content: "# Service status\n\nAll systems are operational.",
	},
	{
		name: "an image-heavy page with resolved targets and labels",
		title: "Summer catalog",
		content: [
			"# Summer catalog",
			"",
			...Array.from({ length: 8 }, (_, index) => `[![Product ${index + 1}](https://images.example.test/product-${index + 1}.jpg)](https://shop.example.test/products/${index + 1})`),
		].join("\n\n"),
	},
	{
		name: "uncertain empty structure without corroborating shell evidence",
		title: "Community gallery",
		content: [
			"# Community gallery",
			"",
			"A small gallery is being curated by community members.",
			"",
			...Array.from({ length: 6 }, (_, index) => `[](https://example.test/gallery/${index + 1})`),
		].join("\n"),
	},
]) {
	test(`fetch_content accepts ${acceptedCase.name}`, async () => {
		const home = await createHome();
		const child = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				calls.push(String(url));
				return new Response(${JSON.stringify(acceptedCase.content)}, { headers: { "content-type": "text/markdown" } });
			};
			const { extractContent } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractContent("https://example.test/candidate", undefined, { lookup: ${lookupSource} });
			console.log(JSON.stringify({ calls, result }));
		`, home);

		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.calls, ["https://example.test/candidate"]);
		assert.equal(output.result.error, null);
		assert.equal(output.result.title, acceptedCase.title);
		assert.equal(output.result.content, acceptedCase.content);
	});
}
