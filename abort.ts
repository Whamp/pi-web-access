export function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Settle with an abort signal even when the underlying promise ignores cancellation.
 * Both promise branches remain observed so a late settlement cannot resume work or
 * become an unhandled rejection.
 */
export function settleWithAbort<T>(start: () => PromiseLike<T>, signal?: AbortSignal | null): Promise<T> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));

	let operation: PromiseLike<T>;
	try {
		operation = start();
	} catch (error) {
		return Promise.reject(error);
	}
	const observed = Promise.resolve(operation);
	if (!signal) return observed;
	if (signal.aborted) {
		void observed.catch(() => {});
		return Promise.reject(abortReason(signal));
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });

		observed.then(
			(value) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
