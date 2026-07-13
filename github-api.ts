import { execFile } from "node:child_process";
import { abortReason } from "./abort.ts";
import type { ExtractedContent } from "./extract.ts";
import type { GitHubUrlInfo } from "./github-extract.ts";

const MAX_TREE_ENTRIES = 200;
const MAX_INLINE_FILE_CHARS = 100_000;

let ghAvailable: boolean | null = null;
let ghHintShown = false;

interface GhExecOptions {
	timeout: number;
	maxBuffer?: number;
}

function execGh(args: string[], options: GhExecOptions, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));

	return new Promise((resolve, reject) => {
		const child = execFile("gh", args, options, (error, stdout) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(abortReason(signal));
				return;
			}
			if (error) {
				reject(error);
				return;
			}
			resolve(stdout);
		});
		const onAbort = (): void => {
			child.kill("SIGKILL");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

export async function checkGhAvailable(signal?: AbortSignal): Promise<boolean> {
	if (ghAvailable !== null) return ghAvailable;

	try {
		await execGh(["--version"], { timeout: 5000 }, signal);
		ghAvailable = true;
	} catch {
		throwIfAborted(signal);
		ghAvailable = false;
	}
	return ghAvailable;
}

export function showGhHint(): void {
	if (!ghHintShown) {
		ghHintShown = true;
		console.error("[pi-web-access] Install `gh` CLI for better GitHub repo access including private repos.");
	}
}

export async function checkRepoSize(owner: string, repo: string, signal?: AbortSignal): Promise<number | null> {
	if (!(await checkGhAvailable(signal))) return null;

	try {
		const stdout = await execGh(["api", `repos/${owner}/${repo}`, "--jq", ".size"], { timeout: 10000 }, signal);
		const kb = parseInt(stdout.trim(), 10);
		return Number.isNaN(kb) ? null : kb;
	} catch {
		throwIfAborted(signal);
		return null;
	}
}

async function getDefaultBranch(owner: string, repo: string, signal?: AbortSignal): Promise<string | null> {
	if (!(await checkGhAvailable(signal))) return null;

	try {
		const stdout = await execGh(["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"], { timeout: 10000 }, signal);
		return stdout.trim() || null;
	} catch {
		throwIfAborted(signal);
		return null;
	}
}

async function fetchTreeViaApi(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<string | null> {
	if (!(await checkGhAvailable(signal))) return null;

	try {
		const stdout = await execGh(
			["api", `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, "--jq", ".tree[].path"],
			{ timeout: 15000, maxBuffer: 5 * 1024 * 1024 },
			signal,
		);
		const paths = stdout.trim().split("\n").filter(Boolean);
		if (paths.length === 0) return null;
		const truncated = paths.length > MAX_TREE_ENTRIES;
		const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
		return truncated ? display + `\n... (${paths.length} total entries)` : display;
	} catch {
		throwIfAborted(signal);
		return null;
	}
}

async function fetchReadmeViaApi(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<string | null> {
	if (!(await checkGhAvailable(signal))) return null;

	try {
		const stdout = await execGh(
			["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"],
			{ timeout: 10000 },
			signal,
		);
		const decoded = Buffer.from(stdout.trim(), "base64").toString("utf-8");
		return decoded.length > 8192 ? decoded.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : decoded;
	} catch {
		throwIfAborted(signal);
		return null;
	}
}

async function fetchFileViaApi(owner: string, repo: string, path: string, ref: string, signal?: AbortSignal): Promise<string | null> {
	if (!(await checkGhAvailable(signal))) return null;

	try {
		const stdout = await execGh(
			["api", `repos/${owner}/${repo}/contents/${path}?ref=${ref}`, "--jq", ".content"],
			{ timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
			signal,
		);
		return Buffer.from(stdout.trim(), "base64").toString("utf-8");
	} catch {
		throwIfAborted(signal);
		return null;
	}
}

export async function fetchViaApi(
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	sizeNote?: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const ref = info.ref || (await getDefaultBranch(owner, repo, signal));
	if (!ref) return null;

	const lines: string[] = [];
	if (sizeNote) {
		lines.push(sizeNote);
		lines.push("");
	}

	if (info.type === "blob" && info.path) {
		const content = await fetchFileViaApi(owner, repo, info.path, ref, signal);
		if (!content) return null;

		lines.push(`## ${info.path}`);
		if (content.length > MAX_INLINE_FILE_CHARS) {
			lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
			lines.push(`\n[File truncated at 100K chars]`);
		} else {
			lines.push(content);
		}

		return {
			url,
			title: `${owner}/${repo} - ${info.path}`,
			content: lines.join("\n"),
			error: null,
		};
	}

	const [treeResult, readmeResult] = await Promise.allSettled([
		fetchTreeViaApi(owner, repo, ref, signal),
		fetchReadmeViaApi(owner, repo, ref, signal),
	]);
	throwIfAborted(signal);
	const tree = treeResult.status === "fulfilled" ? treeResult.value : null;
	const readme = readmeResult.status === "fulfilled" ? readmeResult.value : null;
	if (!tree && !readme) return null;

	if (tree) {
		lines.push("## Structure");
		lines.push(tree);
		lines.push("");
	}

	if (readme) {
		lines.push("## README.md");
		lines.push(readme);
		lines.push("");
	}

	lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");

	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return {
		url,
		title,
		content: lines.join("\n"),
		error: null,
	};
}
