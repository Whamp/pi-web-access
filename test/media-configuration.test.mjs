import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createWebAccessConfiguration } from "../configuration.ts";
import { isYouTubeEnabled } from "../youtube-extract.ts";
import { isVideoFile } from "../video-extract.ts";

const extractorUrl = new URL("../extract.ts", import.meta.url).href;
const configurationUrl = new URL("../configuration.ts", import.meta.url).href;

async function configurationWith(raw) {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-access-media-configuration-"));
	const sourcePath = join(directory, "web-search.json");
	if (raw !== undefined) await writeFile(sourcePath, JSON.stringify(raw));
	return { directory, settings: createWebAccessConfiguration({ sourcePath }).current() };
}

test("YouTube enablement follows configured and default Web Access settings", async () => {
	const configured = await configurationWith({ youtube: { enabled: false } });
	const defaults = await configurationWith(undefined);

	assert.equal(isYouTubeEnabled(configured.settings.youtube), false);
	assert.equal(isYouTubeEnabled(defaults.settings.youtube), true);
});

test("local-video recognition follows configured enablement and maximum size", async () => {
	const { directory, settings } = await configurationWith({ video: { enabled: true, maxSizeMB: 0.000001 } });
	const filePath = join(directory, "clip.mp4");
	await writeFile(filePath, Buffer.alloc(2));

	assert.equal(isVideoFile(filePath, settings.video), null);

	const enabled = await configurationWith({ video: { enabled: true, maxSizeMB: 1 } });
	assert.equal(isVideoFile(filePath, enabled.settings.video)?.absolutePath, filePath);

	const disabled = await configurationWith({ video: { enabled: false, maxSizeMB: 1 } });
	assert.equal(isVideoFile(filePath, disabled.settings.video), null);
});

test("local-video extraction uses the configured model and retains upload cleanup", async () => {
	const { directory } = await configurationWith(undefined);
	const configPath = join(directory, "configured.json");
	const filePath = join(directory, "configured.mp4");
	await writeFile(configPath, JSON.stringify({ video: { preferredModel: "configured-video-model" } }));
	await writeFile(filePath, "video-data");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildLocalVideoChildScript(extractorUrl, configurationUrl),
		encoding: "utf8",
		env: { ...process.env, GEMINI_API_KEY: "test-key", TEST_CONFIG_PATH: configPath, TEST_VIDEO_PATH: filePath },
	});

	assert.equal(child.status, 0, child.stderr || child.stdout);
	const result = JSON.parse(child.stdout);
	assert.equal(result.content, "# Configured video\nTranscript");
	assert.match(result.modelUrl, /\/models\/configured-video-model:generateContent/);
	assert.equal(result.cleanedUp, true);
});

test("media defaults recognize a local video through Web Access settings", async () => {
	const { directory, settings } = await configurationWith(undefined);
	const filePath = join(directory, "default.mp4");
	await writeFile(filePath, "video");

	assert.equal(settings.youtube.preferredModel, "gemini-3-flash-preview");
	assert.equal(settings.video.preferredModel, "gemini-3-flash-preview");
	assert.equal(isYouTubeEnabled(), true);
	assert.equal(isVideoFile(filePath)?.absolutePath, filePath);
	assert.equal(isVideoFile(filePath, settings.video)?.absolutePath, filePath);
});

function buildLocalVideoChildScript(moduleUrl, configModuleUrl) {
	return `
		let modelUrl = "";
		let cleanedUp = false;
		globalThis.fetch = async (input, init = {}) => {
			const url = String(input);
			if (url.includes("/upload/v1beta/files")) {
				return new Response(null, { status: 200, headers: { "x-goog-upload-url": "https://upload.test/video" } });
			}
			if (url === "https://upload.test/video") {
				return Response.json({ file: { name: "files/configured", uri: "https://files.test/configured" } });
			}
			if (url.includes("/models/")) {
				modelUrl = url;
				return Response.json({ candidates: [{ content: { parts: [{ text: "# Configured video\\nTranscript" }] } }] });
			}
			if (url.includes("/files/configured")) {
				if (init.method === "DELETE") {
					cleanedUp = true;
					return new Response(null, { status: 204 });
				}
				return Response.json({ state: "ACTIVE" });
			}
			throw new Error("Unexpected fetch: " + url);
		};
		const { createWebAccessConfiguration } = await import(${JSON.stringify(configModuleUrl)});
		const { extractContent } = await import(${JSON.stringify(moduleUrl)});
		const media = createWebAccessConfiguration({ sourcePath: process.env.TEST_CONFIG_PATH }).current();
		const result = await extractContent(process.env.TEST_VIDEO_PATH, undefined, { media });
		console.log(JSON.stringify({ ...result, modelUrl, cleanedUp }));
	`;
}
