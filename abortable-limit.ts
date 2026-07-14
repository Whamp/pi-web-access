import { abortReason } from "./abort.ts";

export interface AbortableLimiter {
	run<T>(task: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T>;
}

interface QueueEntry {
	previous: QueueEntry | null;
	next: QueueEntry | null;
	queued: boolean;
	start(): void;
}

export function createAbortableLimiter(concurrency: number): AbortableLimiter {
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new TypeError("Concurrency must be a positive integer");
	}

	let activeCount = 0;
	let queueHead: QueueEntry | null = null;
	let queueTail: QueueEntry | null = null;

	const unlink = (entry: QueueEntry): void => {
		if (!entry.queued) return;
		if (entry.previous) entry.previous.next = entry.next;
		else queueHead = entry.next;
		if (entry.next) entry.next.previous = entry.previous;
		else queueTail = entry.previous;
		entry.previous = null;
		entry.next = null;
		entry.queued = false;
	};

	const enqueue = (entry: QueueEntry): void => {
		entry.previous = queueTail;
		entry.next = null;
		entry.queued = true;
		if (queueTail) queueTail.next = entry;
		else queueHead = entry;
		queueTail = entry;
	};

	const dequeue = (): QueueEntry | null => {
		const entry = queueHead;
		if (!entry) return null;
		unlink(entry);
		return entry;
	};

	const drain = (): void => {
		while (activeCount < concurrency) {
			const entry = dequeue();
			if (!entry) return;
			entry.start();
		}
	};

	return {
		run<T>(task: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
			if (signal?.aborted) return Promise.reject(abortReason(signal));

			return new Promise<T>((resolve, reject) => {
				let state: "queued" | "running" | "settled" = "queued";
				const entry: QueueEntry = {
					previous: null,
					next: null,
					queued: false,
					start(): void {
						if (state !== "queued") return;
						state = "running";
						signal?.removeEventListener("abort", onAbort);
						activeCount += 1;
						Promise.resolve()
							.then(task)
							.then(resolve, reject)
							.finally(() => {
								state = "settled";
								activeCount -= 1;
								drain();
							});
					},
				};
				const onAbort = (): void => {
					if (state !== "queued") return;
					state = "settled";
					unlink(entry);
					signal?.removeEventListener("abort", onAbort);
					reject(signal ? abortReason(signal) : new DOMException("The operation was aborted.", "AbortError"));
				};

				enqueue(entry);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort();
				else drain();
			});
		},
	};
}
