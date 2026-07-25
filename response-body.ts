import { request as requestHttp, type IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { abortReason, settleWithAbort } from "./abort.ts";
import { ResponseBodyTooLargeError } from "./errors.ts";

const DISPOSAL_GRACE_MS = 100;
const HEADERS_OVERFLOW_ERROR_CODE = "UND_ERR_HEADERS_OVERFLOW";

/** Configures an owned response fetch retry after Node fetch rejects oversized response headers. */
export interface OwnedResponseFetchOptions {
	/** Aggregate response-header limit in bytes for a GET or HEAD request with manual redirects. */
	maxResponseHeaderSize?: number;
}

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

/** Fetches a signal-owned response and abandons any response that arrives after cancellation. */
export function fetchOwnedResponse(
	input: RequestInfo | URL,
	init: RequestInit,
	signal: AbortSignal,
	options: OwnedResponseFetchOptions = {},
): Promise<Response> {
	return settleWithAbort(
		async () => {
			try {
				return await fetch(input, { ...init, signal });
			} catch (error) {
				if (options.maxResponseHeaderSize === undefined || !hasErrorCode(error, HEADERS_OVERFLOW_ERROR_CODE)) {
					throw error;
				}
				signal.throwIfAborted();
				return fetchOwnedResponseWithNodeHttp(input, init, signal, options.maxResponseHeaderSize);
			}
		},
		signal,
		lateResponse => abandonResponseBody(lateResponse, "Response arrived after its owner settled"),
	);
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
	let current = error;
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
		if ("code" in current && current.code === expectedCode) {
			return true;
		}
		current = "cause" in current ? current.cause : undefined;
	}
	return false;
}

function incomingMessageToResponseBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
	const iterator = incoming[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const chunk = await iterator.next();
				if (chunk.done) {
					controller.close();
				} else if (chunk.value instanceof Uint8Array) {
					controller.enqueue(chunk.value);
				} else {
					const error = new Error("Large response-header retry received a non-byte body chunk");
					incoming.destroy(error);
					controller.error(error);
				}
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			incoming.destroy(reason instanceof Error
				? reason
				: new Error("Large response-header retry body was cancelled"));
		},
	});
}

function fetchOwnedResponseWithNodeHttp(
	input: RequestInfo | URL,
	init: RequestInit,
	signal: AbortSignal,
	maxResponseHeaderSize: number,
): Promise<Response> {
	const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	if ((method !== "GET" && method !== "HEAD") || init.body != null) {
		throw new Error("Large response-header retry supports only GET and HEAD requests");
	}
	if (init.redirect !== "manual") {
		throw new Error("Large response-header retry requires manual redirect handling");
	}

	const url = new URL(input instanceof Request ? input.url : input);
	const request = url.protocol === "https:"
		? requestHttps
		: url.protocol === "http:"
			? requestHttp
			: null;
	if (!request) {
		throw new Error(`Large response-header retry does not support ${url.protocol} URLs`);
	}

	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	new Headers(init.headers).forEach((value, name) => headers.set(name, value));
	return new Promise((resolve, reject) => {
		const nodeRequest = request(url, {
			method,
			headers: Object.fromEntries(headers),
			maxHeaderSize: maxResponseHeaderSize,
			signal,
		}, incoming => {
			const status = incoming.statusCode;
			if (status === undefined) {
				incoming.destroy();
				reject(new Error("Large response-header retry received no HTTP status"));
				return;
			}
			const responseHeaders = new Headers();
			for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
				const name = incoming.rawHeaders[index];
				const value = incoming.rawHeaders[index + 1];
				if (name !== undefined && value !== undefined) {
					responseHeaders.append(name, value);
				}
			}
			resolve(new Response(incomingMessageToResponseBody(incoming), {
				status,
				statusText: incoming.statusMessage,
				headers: responseHeaders,
			}));
		});
		nodeRequest.once("error", reject);
		nodeRequest.end();
	});
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
