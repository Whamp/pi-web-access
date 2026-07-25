import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const extractorUrl = new URL("../extract.ts", import.meta.url).href;

const PUBLIC_VIDEO_URL = "https://youtu.be/ZPu3kezlC08?is=FsJm4ahtxIzMpQ2J";

/** Creates a deterministic yt-dlp executable that exposes public metadata and captions. */
async function createFakeYtDlp(directory) {
	const executablePath = join(directory, "yt-dlp");
	const metadata = {
		title: "Public Test Video",
		channel: "Test Channel",
		upload_date: "20240102",
		duration: 65,
		requested_subtitles: {
			en: {
				ext: "json3",
				url: "https://captions.example/public-video.json3",
				http_headers: { "User-Agent": "yt-dlp-test" },
			},
		},
	};
	await writeFile(executablePath, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(metadata)}'\n`);
	await chmod(executablePath, 0o755);
	return executablePath;
}

test("YouTube extraction combines Gemini analysis with public metadata and captions", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-combined-"));
	const fakeBin = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-bin-"));
	await createFakeYtDlp(fakeBin);
	const env = createYouTubeTestEnvironment(home, `${fakeBin}${delimiter}${process.env.PATH ?? ""}`);
	env.GEMINI_API_KEY = "test-gemini-key";

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildYouTubeExtractionChildScript(extractorUrl, true),
		encoding: "utf8",
		env,
	});

	assert.equal(child.status, 0, child.stderr || child.stdout);
	const result = JSON.parse(child.stdout);
	assert.equal(result.url, PUBLIC_VIDEO_URL);
	assert.equal(result.title, "Public Test Video");
	assert.equal(result.duration, 65);
	assert.equal(result.error, null);
	assert.match(result.content, /## Gemini Video Analysis/);
	assert.match(result.content, /Gemini visual context about a map shown in the video\./);
	assert.match(result.content, /# Public Test Video/);
	assert.match(result.content, /\*\*Channel:\*\* Test Channel/);
	assert.match(result.content, /\*\*Published:\*\* 2024-01-02/);
	assert.match(result.content, /\*\*Duration:\*\* 1:05/);
	assert.match(result.content, /## Transcript/);
	assert.match(result.content, /\[0:01\] First caption line\./);
	assert.match(result.content, /\[0:03\] Second caption line\./);
	assert.doesNotMatch(result.content, /unavailable/i);
});

test("YouTube extraction falls back to public yt-dlp metadata and captions", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-public-"));
	const fakeBin = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-bin-"));
	await createFakeYtDlp(fakeBin);
	const env = createYouTubeTestEnvironment(home, `${fakeBin}${delimiter}${process.env.PATH ?? ""}`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildYouTubeExtractionChildScript(extractorUrl, false),
		encoding: "utf8",
		env,
	});

	assert.equal(child.status, 0, child.stderr || child.stdout);
	const result = JSON.parse(child.stdout);
	assert.equal(result.url, PUBLIC_VIDEO_URL);
	assert.equal(result.title, "Public Test Video");
	assert.equal(result.error, null);
	assert.match(result.content, /# Public Test Video/);
	assert.match(result.content, /\*\*Channel:\*\* Test Channel/);
	assert.match(result.content, /\*\*Published:\*\* 2024-01-02/);
	assert.match(result.content, /\*\*Duration:\*\* 1:05/);
	assert.match(result.content, /## Transcript/);
	assert.match(result.content, /\[0:01\] First caption line\./);
	assert.match(result.content, /\[0:03\] Second caption line\./);
	assert.match(result.content, /Gemini video analysis was unavailable/);
});

test("YouTube extraction reports unavailable public transcript enrichment", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-gemini-only-"));
	const env = createYouTubeTestEnvironment(home, "");
	env.GEMINI_API_KEY = "test-gemini-key";

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildYouTubeExtractionChildScript(extractorUrl, true),
		encoding: "utf8",
		env,
	});

	assert.equal(child.status, 0, child.stderr || child.stdout);
	const result = JSON.parse(child.stdout);
	assert.equal(result.error, null);
	assert.match(result.content, /Gemini visual context about a map shown in the video\./);
	assert.match(result.content, /Public metadata and captions were unavailable/);
	assert.doesNotMatch(result.content, /## Transcript/);
});

test("YouTube extraction preserves Gemini analysis when public captions cannot be parsed", async () => {
	const captionBodies = [
		"not JSON",
		JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: "\n" }] }] }),
	];

	for (const captionBody of captionBodies) {
		const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-caption-parse-"));
		const fakeBin = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-bin-"));
		await createFakeYtDlp(fakeBin);
		const env = createYouTubeTestEnvironment(home, `${fakeBin}${delimiter}${process.env.PATH ?? ""}`);
		env.GEMINI_API_KEY = "test-gemini-key";

		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: buildYouTubeExtractionChildScript(extractorUrl, true, captionBody),
			encoding: "utf8",
			env,
		});

		assert.equal(child.status, 0, child.stderr || child.stdout);
		const result = JSON.parse(child.stdout);
		assert.equal(result.error, null);
		assert.match(result.content, /Gemini visual context about a map shown in the video\./);
		assert.match(result.content, /Public metadata and captions were unavailable/);
		assert.doesNotMatch(result.content, /## Transcript/);
	}
});

function createYouTubeTestEnvironment(home, executablePath) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PATH: executablePath,
		GEMINI_API_KEY: "",
		PERPLEXITY_API_KEY: "",
	};
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;
	return env;
}

function buildYouTubeExtractionChildScript(moduleUrl, includeGeminiResponse, captionResponseBody = null) {
	return `
		const includeGeminiResponse = ${JSON.stringify(includeGeminiResponse)};
		const captionResponseBody = ${JSON.stringify(captionResponseBody)};
		globalThis.fetch = async (input, init = {}) => {
			const url = String(input);
			if (url.startsWith("https://generativelanguage.googleapis.com/")) {
				if (!includeGeminiResponse) {
					throw new Error("Unexpected Gemini API request");
				}
				return Response.json({ candidates: [{ content: { parts: [{
					text: "### Key Takeaways\\n\\nGemini visual context about a map shown in the video.",
				}] } }] });
			}
			if (url === "https://captions.example/public-video.json3") {
				if (new Headers(init.headers).get("User-Agent") !== "yt-dlp-test") {
					throw new Error("Caption request omitted yt-dlp headers");
				}
				if (captionResponseBody !== null) {
					return new Response(captionResponseBody, {
						headers: { "content-type": "application/json" },
					});
				}
				return Response.json({ events: [
					{ tStartMs: 1000, segs: [{ utf8: "First caption line." }] },
					{ tStartMs: 2000, segs: [{ utf8: "\\n" }] },
					{ tStartMs: 3000, segs: [{ utf8: "Second caption line." }] },
				] });
			}
			if (url.startsWith("https://img.youtube.com/")) {
				return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
			}
			throw new Error("Unexpected fetch: " + url);
		};

		const { extractContent } = await import(${JSON.stringify(moduleUrl)});
		const result = await extractContent(
			${JSON.stringify(PUBLIC_VIDEO_URL)},
			undefined,
			{ prompt: "Return complete high-quality transcript, metadata, analysis, and visual context." },
		);
		console.log(JSON.stringify(result));
	`;
}
