import assert from "node:assert/strict";
import { test } from "node:test";

import { queryWithCookies } from "../gemini-web.ts";

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function settlesWithin(promise, label) {
	let timeoutId;
	try {
		return await Promise.race([
			promise,
			new Promise((_resolve, reject) => {
				timeoutId = setTimeout(() => reject(new Error(`${label} did not settle promptly`)), 100);
			}),
		]);
	} finally {
		clearTimeout(timeoutId);
	}
}

test("Gemini Web body consumption settles and cancels on owner abort", async () => {
	const originalFetch = globalThis.fetch;
	const bodyStarted = deferred();
	let bodyController;
	let bodyCancelled = false;
	globalThis.fetch = async (url) => {
		const requestUrl = String(url);
		if (requestUrl === "https://gemini.google.com/app") {
			return new Response('<html>"SNlM0e":"test-token"</html>', { status: 200 });
		}
		if (requestUrl.includes("StreamGenerate")) {
			return new Response(new ReadableStream({
				start(controller) {
					bodyController = controller;
				},
				pull() {
					bodyStarted.resolve();
				},
				cancel() {
					bodyCancelled = true;
				},
			}), { status: 200 });
		}
		throw new Error(`Unexpected fetch: ${requestUrl}`);
	};

	const owner = new AbortController();
	const ownerReason = new Error("cancel Gemini Web body");
	const execution = queryWithCookies("extract page", {
		"__Secure-1PSID": "test-cookie",
		"__Secure-1PSIDTS": "test-cookie-ts",
	}, { signal: owner.signal, timeoutMs: 10_000 });
	try {
		await settlesWithin(bodyStarted.promise, "Gemini Web body start");
		owner.abort(ownerReason);
		await assert.rejects(settlesWithin(execution, "Gemini Web body cancellation"), (error) => error === ownerReason);
		assert.equal(bodyCancelled, true, "Gemini Web body must cancel before query settlement");
	} finally {
		if (!bodyCancelled) bodyController?.close();
		await execution.catch(() => {});
		globalThis.fetch = originalFetch;
	}
});
