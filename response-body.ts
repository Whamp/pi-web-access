import { abortReason } from "./abort.ts";

export async function discardResponseBody(response: Response, reason = "Response body was not consumed"): Promise<void> {
	if (!response.body || response.body.locked) return;
	await response.body.cancel(reason);
}

export async function readResponseBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
	if (!response.body) {
		const buffer = await response.arrayBuffer();
		signal?.throwIfAborted();
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
			await cancel(abortReason(signal)).catch(() => {});
			throw abortReason(signal);
		}

		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
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
			await cancel(abortReason(signal)).catch(() => {});
			throw abortReason(signal);
		}
		await cancel(error).catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}
