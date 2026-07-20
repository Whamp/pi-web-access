import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { convertDocument, isConvertibleDocument } from "../document-converter.ts";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("document classification accepts supported MIME types and generic Office URLs", () => {
	assert.equal(isConvertibleDocument("https://example.test/download", "application/pdf"), true);
	assert.equal(isConvertibleDocument("https://example.test/report.docx", "application/octet-stream"), true);
	assert.equal(isConvertibleDocument("https://example.test/slides.pptx", "application/zip"), true);
	assert.equal(isConvertibleDocument("https://example.test/sheet.xlsx", ""), true);
});

test("document classification does not override a specific unsupported MIME type", () => {
	assert.equal(isConvertibleDocument("https://example.test/report.docx", "text/html"), false);
	assert.equal(isConvertibleDocument("https://example.test/archive.zip", "application/zip"), false);
});

test("document conversion accepts already-retrieved bytes", async () => {
	const bytes = await readFile(new URL("./fixtures/simple.docx", import.meta.url));
	const result = await convertDocument(bytes, "https://example.test/simple.docx", DOCX_MIME_TYPE);
	assert.match(result.markdown, /Hello from DOCX/);
});
