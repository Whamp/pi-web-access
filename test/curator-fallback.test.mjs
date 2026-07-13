import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateCuratorPage } from "../curator-page.ts";

const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("manual websearch command reports browser-open fallback without closing curator", () => {
	assert.match(indexSrc, /let browserOpenError: string \| null = null;/);
	assert.match(indexSrc, /ctx\.ui\.notify\(`Search curator is running, but the browser did not open automatically\. Open manually: \$\{handle\.url\}`/);
	assert.match(indexSrc, /if \(queries\.length > 0\) \{/);
});

test("README documents manual browser fallback", () => {
	assert.match(readmeSrc, /Docker, WSL, SSH, or headless environments/);
	assert.match(readmeSrc, /Copy it into a browser that can reach the Pi host/);
});

test("curator shows an ineligible strict default instead of silently replacing it", () => {
	const html = generateCuratorPage(
		["query"],
		"token",
		20,
		{ openai: false, brave: false, parallel: false, tavily: false, perplexity: false, exa: true, gemini: false },
		"brave",
		"brave",
		[],
		null,
	);

	assert.match(html, /data-provider="brave"[^>]*title="Brave is ineligible/);
	assert.match(html, /Brave \(ineligible\)/);
	assert.doesNotMatch(html, /data-provider="exa"[^>]*is-default/);
});
