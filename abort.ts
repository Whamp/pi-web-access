export function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Settle with an abort signal even when the underlying promise ignores cancellation.
 * Both promise branches remain observed so a late settlement cannot resume work or
 * become an unhandled rejection.
 */
export function settleWithAbort<T>(
	start: () => PromiseLike<T>,
	signal?: AbortSignal | null,
	onLateResolve?: (value: T) => void | PromiseLike<void>,
): Promise<T> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));

	let operation: PromiseLike<T>;
	try {
		operation = start();
	} catch (error) {
		return Promise.reject(error);
	}
	const observed = Promise.resolve(operation);
	const disposeLate = (value: T): void => {
		if (!onLateResolve) return;
		try {
			void Promise.resolve(onLateResolve(value)).catch(() => {});
		} catch {
		}
	};
	if (!signal) return observed;
	if (signal.aborted) {
		observed.then(disposeLate, () => {});
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
				if (settled) {
					disposeLate(value);
					return;
				}
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
