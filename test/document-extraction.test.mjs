import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { extractContent } from "../extract.ts";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("fetch_content converts a DOCX response to readable Markdown", async () => {
	const originalFetch = globalThis.fetch;
	const bytes = await readFile(new URL("./fixtures/simple.docx", import.meta.url));
	globalThis.fetch = async () => new Response(bytes, {
		headers: {
			"content-length": String(6 * 1024 * 1024),
			"content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		},
	});

	try {
		const result = await extractContent("https://example.test/simple.docx", undefined, { lookup });
		assert.equal(result.error, null);
		assert.match(result.content, /Markit Document/);
		assert.match(result.content, /Hello from DOCX/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

for (const documentCase of [
	{
		format: "PPTX",
		filename: "simple.pptx",
		contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		expected: /Hello from PPTX/,
	},
	{
		format: "XLSX",
		filename: "simple.xlsx",
		contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		expected: /Hello from XLSX/,
	},
	{
		format: "PDF",
		filename: "simple.pdf",
		contentType: "application/pdf",
		expected: /Hello from PDF/,
	},
]) {
	test(`fetch_content converts a ${documentCase.format} response to readable Markdown`, async () => {
		const originalFetch = globalThis.fetch;
		const bytes = await readFile(new URL(`./fixtures/${documentCase.filename}`, import.meta.url));
		globalThis.fetch = async () => new Response(bytes, {
			headers: { "content-type": documentCase.contentType },
		});

		try {
			const result = await extractContent(`https://example.test/${documentCase.filename}`, undefined, { lookup });
			assert.equal(result.error, null);
			assert.match(result.content, documentCase.expected);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
}

test("fetch_content reports the document byte limit when a convertible document exceeds its cap after abort", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(6 * 1024 * 1024));
			controller.enqueue(new Uint8Array(6 * 1024 * 1024));
			controller.enqueue(new Uint8Array(6 * 1024 * 1024));
			controller.enqueue(new Uint8Array(6 * 1024 * 1024));
		},
	}), {
		headers: {
			"content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		},
	});

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 50);
	try {
		const result = await extractContent("https://example.test/large.docx", controller.signal, { lookup });
		assert.match(result.error ?? "", /^Response too large \(limit 20MB\)/);
	} finally {
		clearTimeout(timeout);
		globalThis.fetch = originalFetch;
	}
});

test("fetch_content rejects a chunked response that exceeds the actual byte limit", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCount = 0;
	let cancelled = false;
	globalThis.fetch = async () => {
		fetchCount += 1;
		return new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new Uint8Array(3 * 1024 * 1024));
				controller.enqueue(new Uint8Array(3 * 1024 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		}), {
			headers: { "content-type": "text/plain" },
		});
	};

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 250);
	try {
		const result = await extractContent("https://example.test/large.txt", controller.signal, { lookup });
		assert.match(result.error ?? "", /^Response too large/);
		assert.equal(fetchCount, 1);
		assert.equal(cancelled, true);
	} finally {
		clearTimeout(timeout);
		globalThis.fetch = originalFetch;
	}
});
