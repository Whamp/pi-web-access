import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createWebAccessConfiguration } from "../configuration.ts";
import { extractContent } from "../extract.ts";
import { clearCloneCache, extractGitHub } from "../github-extract.ts";

test("content retrieval uses validated SSRF ranges supplied by Web Access configuration", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("# Allowed\n\n" + "content ".repeat(100), {
		status: 200,
		headers: { "content-type": "text/markdown" },
	});
	try {
		const directory = await mkdtemp(join(tmpdir(), "pi-web-access-ssrf-settings-"));
		const sourcePath = join(directory, "web-search.json");
		await writeFile(sourcePath, JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15"] } }));
		const settings = createWebAccessConfiguration({ sourcePath }).current();
		await writeFile(sourcePath, JSON.stringify({ ssrf: { allowRanges: [] } }));
		const lookup = async () => [{ address: "198.18.0.56", family: 4 }];
		const defaultSettings = createWebAccessConfiguration({ sourcePath: join(directory, "missing.json") }).current();
		const blocked = await extractContent("https://example.test/page", undefined, { lookup, settings: defaultSettings });
		assert.match(blocked.error, /Blocked internal address/);

		const allowed = await extractContent("https://example.test/page", undefined, {
			lookup,
			settings,
		});
		assert.equal(allowed.error, null);
		assert.match(allowed.content, /Allowed/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("GitHub extraction uses supplied clone settings and keeps clone-result caching", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-settings-"));
	const fakeBin = join(root, "bin");
	const cloneRoot = join(root, "clones");
	const countPath = join(root, "clone-count");
	await mkdir(fakeBin, { recursive: true });
	const ghPath = join(fakeBin, "gh");
	await writeFile(ghPath, `#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("gh version test"); process.exit(0); }
if (process.argv[2] === "api") { console.log("1"); process.exit(0); }
const localPath = process.argv[5];
mkdirSync(localPath, { recursive: true });
writeFileSync(localPath + "/README.md", "# Configured clone");
let count = 0;
try { count = Number(readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
writeFileSync(${JSON.stringify(countPath)}, String(count + 1));
`);
	await chmod(ghPath, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
	const sourcePath = join(root, "web-search.json");
	await writeFile(sourcePath, JSON.stringify({ githubClone: { clonePath: cloneRoot } }));
	const settings = createWebAccessConfiguration({ sourcePath }).current().githubClone;
	try {
		const first = await extractGitHub("https://github.com/example/configured", undefined, true, settings);
		assert.equal(first.error, null);
		assert.match(first.content, new RegExp(`Repository cloned to: ${cloneRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		const second = await extractGitHub("https://github.com/example/configured", undefined, true, settings);
		assert.equal(second.error, null);
		assert.equal(await readFile(countPath, "utf8"), "1", "a cached clone result must be reused");

		clearCloneCache();
		const disabled = await extractGitHub("https://github.com/example/configured", undefined, true, { ...settings, enabled: false });
		assert.equal(disabled, null, "clearing cloned state must not reload or replace supplied configuration");
		assert.equal(await readFile(countPath, "utf8"), "1");
	} finally {
		clearCloneCache();
		process.env.PATH = originalPath;
	}
});
