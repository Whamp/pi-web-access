import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractorUrl = new URL("../extract.ts", import.meta.url).href;
const configurationUrl = new URL("../configuration.ts", import.meta.url).href;

test("YouTube extraction surfaces Gemini API errors", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-errors-"));
	const configPath = join(home, "web-search.json");
	await writeFile(configPath, JSON.stringify({ youtube: { preferredModel: "configured-youtube-model" } }));
	const env = {
		...process.env,
		TEST_WEB_ACCESS_CONFIG: configPath,
		HOME: home,
		USERPROFILE: home,
		PATH: "",
		GEMINI_API_KEY: "test-gemini-key",
		PERPLEXITY_API_KEY: "",
	};
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl, configurationUrl),
		encoding: "utf8",
		env,
	});

	assert.equal(child.status, 0, child.stderr || child.stdout);
	const result = JSON.parse(child.stdout);
	assert.match(result.error, /Gemini API error 503/);
	assert.match(result.requestUrl, /\/models\/configured-youtube-model:generateContent/);
	assert.doesNotMatch(result.error, /Sign into Google in Chrome/);
});

test("YouTube thumbnail retrieval settles on parent cancellation", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-cancellation-"));
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PATH: "",
		GEMINI_API_KEY: "test-gemini-key",
		PERPLEXITY_API_KEY: "",
	};
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildCancellationChildScript(extractorUrl),
		encoding: "utf8",
		env,
	});

	assert.equal(child.status, 0, child.stderr || child.stdout);
	const result = JSON.parse(child.stdout);
	assert.equal(result.thumbnailStarted, true);
	assert.equal(result.outcome, "settled");
	assert.match(result.error, /abort/i);
});

function buildChildScript(moduleUrl, configModuleUrl) {
	return `
		process.on("uncaughtException", (error) => {
			console.error(error?.stack || error);
			process.exit(1);
		});
		process.on("unhandledRejection", (error) => {
			console.error(error?.stack || error);
			process.exit(1);
		});

		let requestUrl = "";
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url.startsWith("https://generativelanguage.googleapis.com/")) {
				requestUrl = url;
				return new Response(JSON.stringify({ error: { message: "model overloaded" } }), {
					status: 503,
					statusText: "Service Unavailable",
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error("Unexpected fetch: " + url);
		};

		const { extractContent } = await import(${JSON.stringify(moduleUrl)});
		const { createWebAccessConfiguration } = await import(${JSON.stringify(configModuleUrl)});
		const media = createWebAccessConfiguration({ sourcePath: process.env.TEST_WEB_ACCESS_CONFIG }).current();
		// Inject DNS so SSRF validation never depends on real resolution (which a
		// local fake-IP/TUN proxy would map into a blocked reserved range).
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const result = await extractContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ", undefined, { lookup, media });
		console.log(JSON.stringify({ ...result, requestUrl }));
	`;
}

function buildCancellationChildScript(moduleUrl) {
	return `
		let startThumbnail;
		const thumbnailStarted = new Promise((resolve) => { startThumbnail = resolve; });
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url.startsWith("https://generativelanguage.googleapis.com/")) {
				return new Response(JSON.stringify({
					candidates: [{ content: { parts: [{ text: "# Video transcript\\nUseful content" }] } }],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (url.startsWith("https://img.youtube.com/")) {
				startThumbnail();
				return new Promise(() => {});
			}
			throw new Error("Unexpected fetch: " + url);
		};

		const { extractContent } = await import(${JSON.stringify(moduleUrl)});
		const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
		const controller = new AbortController();
		const execution = extractContent(
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			controller.signal,
			{ lookup },
		);
		await thumbnailStarted;
		controller.abort(new DOMException("parent aborted", "AbortError"));
		const settled = await Promise.race([
			execution.then((value) => ({ outcome: "settled", error: value.error })),
			new Promise((resolve) => setTimeout(() => resolve({ outcome: "pending", error: "" }), 100)),
		]);
		console.log(JSON.stringify({ thumbnailStarted: true, ...settled }));
	`;
}
