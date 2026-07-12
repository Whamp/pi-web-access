import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README describes bounded terminal full-content retrieval", () => {
	assert.match(readme, /includeContent[^\n]*before (?:the tool )?return/i);
	assert.match(readme, /provider-supplied inline content[^\n]*only missing sources/i);
	assert.match(readme, /fetchId[^\n]*contentReady[^\n]*contentErrors/i);
	assert.match(readme, /get_search_content[^\n]*immediately/i);
});
