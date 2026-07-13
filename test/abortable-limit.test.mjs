import assert from "node:assert/strict";
import { test } from "node:test";

import { createAbortableLimiter } from "../abortable-limit.ts";

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

test("cancelled limiter entries are removed before admission", async () => {
	const limiter = createAbortableLimiter(1);
	const blocker = deferred();
	const blockerStarted = deferred();
	const blockerRun = limiter.run(async () => {
		blockerStarted.resolve();
		await blocker.promise;
	});
	await blockerStarted.promise;

	let cancelledTasksStarted = 0;
	const controllers = Array.from({ length: 20_000 }, () => new AbortController());
	const cancelledRuns = controllers.map((controller) => limiter.run(() => {
		cancelledTasksStarted += 1;
	}, controller.signal));
	const cancellationStartedAt = performance.now();
	for (const controller of controllers) controller.abort(new Error("cancel queued task"));
	await Promise.allSettled(cancelledRuns);
	const cancellationDuration = performance.now() - cancellationStartedAt;
	assert.ok(cancellationDuration < 300, `queued cancellation took ${cancellationDuration.toFixed(1)} ms`);

	const liveStarted = deferred();
	const liveRun = limiter.run(() => liveStarted.resolve());
	blocker.resolve();
	await blockerRun;
	await liveStarted.promise;
	await liveRun;
	assert.equal(cancelledTasksStarted, 0);
});
