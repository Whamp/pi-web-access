import assert from "node:assert/strict";
import { test } from "node:test";

import { ResponseBodyTooLargeError } from "../errors.ts";
import { discardResponseBody, readResponseBytes } from "../response-body.ts";

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("normal body disposal waits for asynchronous cleanup", async () => {
	const cleanup = deferred();
	let cleanupComplete = false;
	const response = new Response(new ReadableStream({
		cancel() {
			return cleanup.promise.then(() => {
				cleanupComplete = true;
			});
		},
	}));

	let disposalComplete = false;
	const disposal = discardResponseBody(response).then(() => {
		disposalComplete = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(disposalComplete, false);
	cleanup.resolve();
	await disposal;
	assert.equal(cleanupComplete, true);
});

test("normal body disposal propagates prompt cleanup failures", async () => {
	const response = new Response(new ReadableStream({
		cancel() {
			throw new Error("cleanup failed");
		},
	}));
	await assert.rejects(discardResponseBody(response), /cleanup failed/);
});

test("normal body disposal starts when its owner is already aborted", async () => {
	let cleanupStarted = false;
	const owner = new AbortController();
	const ownerReason = new Error("owner already cancelled");
	owner.abort(ownerReason);
	const response = new Response(new ReadableStream({
		cancel() {
			cleanupStarted = true;
			return Promise.reject(new Error("cleanup rejected after owner cancellation"));
		},
	}));
	await assert.rejects(discardResponseBody(response, "cancel pre-aborted body", owner.signal), (error) => error === ownerReason);
	assert.equal(cleanupStarted, true);
	await new Promise((resolve) => setImmediate(resolve));
});

test("normal body disposal remains bounded when cleanup never settles", async () => {
	const response = new Response(new ReadableStream({
		cancel() {
			return new Promise(() => {});
		},
	}));
	await Promise.race([
		discardResponseBody(response),
		new Promise((_, reject) => setTimeout(() => reject(new Error("body disposal did not settle")), 250)),
	]);
});

test("response reading cancels a stream when actual bytes exceed the limit", async () => {
	let cancelled = false;
	const response = new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.enqueue(new Uint8Array([4, 5, 6]));
		},
		cancel() {
			cancelled = true;
		},
	}));

	await assert.rejects(
		readResponseBytes(response, undefined, 5),
		(error) => error instanceof ResponseBodyTooLargeError && error.limitBytes === 5,
	);
	assert.equal(cancelled, true);
});
