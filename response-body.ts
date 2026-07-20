import { abortReason, settleWithAbort } from "./abort.ts";
import { ResponseBodyTooLargeError } from "./errors.ts";

const DISPOSAL_GRACE_MS = 100;

/** Await ordinary response cleanup, but never let a broken stream own settlement forever. */
export async function discardResponseBody(
	response: Response,
	reason = "Response body was not consumed",
	signal?: AbortSignal,
): Promise<void> {
	const body = response.body;
	if (!body || body.locked) return;

	let cancellation: Promise<void>;
	try {
		cancellation = body.cancel(reason);
	} catch (error) {
		throw error;
	}
	void cancellation.catch(() => {});

	const graceSignal = AbortSignal.timeout(DISPOSAL_GRACE_MS);
	const disposalSignal = signal ? AbortSignal.any([signal, graceSignal]) : graceSignal;
	try {
		await settleWithAbort(() => cancellation, disposalSignal);
	} catch (error) {
		if (signal?.aborted) throw abortReason(signal);
		if (graceSignal.aborted) return;
		throw error;
	}
}

/** Start cleanup for a response that arrived after its owner settled; never await it. */
export function abandonResponseBody(response: Response, reason = "Response body was abandoned"): void {
	const body = response.body;
	if (!body || body.locked) return;
	try {
		void body.cancel(reason).catch(() => {});
	} catch {
	}
}

export function fetchOwnedResponse(
	input: RequestInfo | URL,
	init: RequestInit,
	signal: AbortSignal,
): Promise<Response> {
	return settleWithAbort(
		() => fetch(input, { ...init, signal }),
		signal,
		lateResponse => abandonResponseBody(lateResponse, "Response arrived after its owner settled"),
	);
}

/** Reads a response body and cancels it when streamed bytes exceed an optional limit. */
export async function readResponseBytes(
	response: Response,
	signal?: AbortSignal,
	maxBytes?: number,
): Promise<Uint8Array> {
	if (!response.body) {
		const buffer = await response.arrayBuffer();
		signal?.throwIfAborted();
		if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
			throw new ResponseBodyTooLargeError(maxBytes, buffer.byteLength);
		}
		return new Uint8Array(buffer);
	}

	const reader = response.body.getReader();
	let cancellation: Promise<void> | undefined;
	const cancel = (reason: unknown): Promise<void> => {
		cancellation ??= reader.cancel(reason);
		return cancellation;
	};
	const onAbort = (): void => {
		if (signal) void cancel(abortReason(signal)).catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		if (signal?.aborted) {
			void cancel(abortReason(signal)).catch(() => {});
			throw abortReason(signal);
		}

		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
			if (maxBytes !== undefined && size > maxBytes) {
				const error = new ResponseBodyTooLargeError(maxBytes, size);
				void cancel(error).catch(() => {});
				throw error;
			}
		}
		signal?.throwIfAborted();

		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} catch (error) {
		if (signal?.aborted) {
			void cancel(abortReason(signal)).catch(() => {});
			throw abortReason(signal);
		}
		void cancel(error).catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

/** Reads a text response and enforces the optional streamed-byte limit before decoding. */
export async function readResponseText(
	response: Response,
	signal?: AbortSignal,
	maxBytes?: number,
): Promise<string> {
	return new TextDecoder().decode(await readResponseBytes(response, signal, maxBytes));
}
