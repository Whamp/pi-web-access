import { execFile, spawn, type ChildProcess } from "node:child_process";
import { abortReason } from "./abort.ts";

const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface RunProcessOptions {
	timeoutMs: number;
	maxBuffer?: number;
}

export function terminateProcessTree(child: ChildProcess): Promise<void> {
	if (child.pid === undefined) {
		child.kill("SIGKILL");
		return Promise.resolve();
	}
	if (process.platform === "win32") {
		return new Promise(resolve => {
			execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
		});
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
	return Promise.resolve();
}

export function runProcess(
	file: string,
	args: string[],
	options: RunProcessOptions,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));

	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
		const stdout: Buffer[] = [];
		let outputBytes = 0;
		let terminalError: unknown;
		let termination: Promise<void> | undefined;
		let finished = false;

		const terminate = (error: unknown): void => {
			if (terminalError === undefined) terminalError = error;
			termination ??= terminateProcessTree(child);
		};
		const onAbort = (): void => {
			if (signal) terminate(abortReason(signal));
		};
		const timeoutId = setTimeout(
			() => terminate(new Error(`${file} timed out after ${options.timeoutMs}ms`)),
			options.timeoutMs,
		);
		timeoutId.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		const collect = (chunk: Buffer, keep: boolean): void => {
			outputBytes += chunk.byteLength;
			if (keep) stdout.push(chunk);
			if (outputBytes > maxBuffer) terminate(new Error(`${file} output exceeded ${maxBuffer} bytes`));
		};
		child.stdout?.on("data", (chunk: Buffer) => collect(chunk, true));
		child.stderr?.on("data", (chunk: Buffer) => collect(chunk, false));

		const finish = (error?: unknown, value?: string): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
			if (error !== undefined) reject(error);
			else resolve(value ?? "");
		};
		child.once("error", error => finish(error));
		child.once("close", (code, childSignal) => {
			void (async () => {
				await termination;
				if (terminalError !== undefined) {
					finish(terminalError);
					return;
				}
				if (code !== 0) {
					finish(new Error(`${file} exited with ${childSignal ?? `code ${code}`}`));
					return;
				}
				finish(undefined, Buffer.concat(stdout).toString("utf8"));
			})();
		});
	});
}
