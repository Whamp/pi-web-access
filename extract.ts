import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { activityMonitor } from "./activity.ts";
import { DEFAULT_MEDIA_SETTINGS, DEFAULT_WEB_ACCESS_SETTINGS, getWebAccessConfiguration, type MediaSettings, type WebAccessSettings } from "./configuration.ts";
import { settleWithAbort } from "./abort.ts";
import { createAbortableLimiter } from "./abortable-limit.ts";
import { extractRSCContent } from "./rsc-extract.ts";
import { convertDocument, isConvertibleDocument } from "./document-converter.ts";
import { extractGitHub } from "./github-extract.ts";
import { isYouTubeURL, isYouTubeEnabled, extractYouTube, extractYouTubeFrame, extractYouTubeFrames, getYouTubeStreamInfo } from "./youtube-extract.ts";
import { extractWithUrlContext, extractWithGeminiWeb } from "./gemini-url-context.ts";
import { extractWithParallel, isParallelAvailable } from "./parallel.ts";
import { ResponseBodyTooLargeError } from "./errors.ts";
import { isVideoFile, extractVideo, extractVideoFrame, getLocalVideoDuration } from "./video-extract.ts";
import { fetchRemoteUrl, validateRemoteUrl, type Lookup } from "./ssrf-protection.ts";
import { formatSeconds } from "./utils.ts";
import { discardResponseBody, fetchOwnedResponse, readResponseBytes, readResponseText } from "./response-body.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_RESPONSE_BYTES = 20 * 1024 * 1024;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];
const MIN_USEFUL_CONTENT = 500;
const BLOCKED_CONTENT_ERROR = "Requested content remained blocked by an anti-bot challenge.";
const CLIENT_RENDERED_SHELL_ERROR = "Requested content remained a Client-rendered shell.";

const SOURCE_REJECTION = {
	Challenge: "challenge",
	ClientRenderedShell: "client-rendered-shell",
} as const;

type SourceRejection = typeof SOURCE_REJECTION[keyof typeof SOURCE_REJECTION];
type ContentRetrievalSettings = Pick<WebAccessSettings, "ssrf" | "githubClone" | "parallelApiKey">;
type SourceRetrievalResult = ExtractedContent | SourceRejection;

interface SourceCandidate {
	headers?: Headers;
	html?: string;
	markdown?: string;
}

const CHALLENGE_INSTRUCTION_PATTERNS = [
	/\bperforming security verification\b/i,
	/\bverif(?:y|ies) (?:that )?you (?:are|(?:'|’)re) (?:a human|not a bot)\b/i,
	/\bcomplete (?:the )?(?:security check|verification|captcha)\b/i,
	/\bplease wait while (?:we|your browser|the website)\b/i,
	/\bconfirm (?:that )?you (?:are|(?:'|’)re) human\b/i,
	/\bselect (?:the )?(?:checkbox|box)\b/i,
	/\bprove (?:that )?you (?:are|(?:'|’)re) human\b/i,
];
const CHALLENGE_CONTEXT_PATTERNS = [
	/\banti-bot\b/i,
	/\bcaptcha\b/i,
	/\bsecurity (?:check|verification)\b/i,
	/\bverify your browser\b/i,
	/\bautomated (?:check|request|traffic)\b/i,
];
const CLIENT_RENDERING_BLOCKER_PATTERNS = [
	/\benable javascript to (?:see|view|load|display|show|browse|access)\b/i,
	/\bjavascript (?:is required|must be enabled) to (?:see|view|load|display|show|browse|access)\b/i,
];
const MAX_STANDALONE_SHELL_TEXT_LENGTH = 100;
const MAX_STRUCTURAL_SHELL_TEXT_LENGTH = 500;
const MIN_REPEATED_PLACEHOLDERS = 4;
const MIN_STRUCTURAL_EMPTY_TARGETS = 8;
const MIN_CLIENT_SCRIPT_TAGS = 4;

function htmlText(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(?:nbsp|amp|quot|#39);/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isInstructionDominatedChallenge(text: string): boolean {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length === 0 || normalized.length > 2_000) {
		return false;
	}
	const instructionCount = CHALLENGE_INSTRUCTION_PATTERNS.filter(pattern => pattern.test(normalized)).length;
	const contextCount = CHALLENGE_CONTEXT_PATTERNS.filter(pattern => pattern.test(normalized)).length;
	return instructionCount >= 2 && contextCount >= 1;
}

function isChallengeCandidate(candidate: SourceCandidate): boolean {
	if (candidate.headers?.get("cf-mitigated")?.trim().toLowerCase() === "challenge") {
		return true;
	}
	if (candidate.html) {
		if (/<iframe\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/challenges\.cloudflare\.com\//i.test(candidate.html)) {
			return true;
		}
		return isInstructionDominatedChallenge(htmlText(candidate.html));
	}
	return candidate.markdown ? isInstructionDominatedChallenge(candidate.markdown) : false;
}

function markdownText(markdown: string): string {
	return markdown
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[\[\]()#*_`>-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function emptyPlaceholderCount(candidate: SourceCandidate): number {
	if (candidate.html) {
		return candidate.html.match(/\b(?:href|src)\s*=\s*["']\s*["']/gi)?.length ?? 0;
	}
	const markdown = candidate.markdown ?? "";
	const imageOnlyLinks = markdown.match(/\[\s*!\[\s*Image \d+\s*\]\([^)]*\)\s*\]\([^)]*\)/gi)?.length ?? 0;
	const emptyLinks = markdown.match(/\[\s*\]\([^)]*\)/g)?.length ?? 0;
	return imageOnlyLinks + emptyLinks;
}

function isClientRenderedShellCandidate(candidate: SourceCandidate): boolean {
	const sourceText = candidate.html ? htmlText(candidate.html) : markdownText(candidate.markdown ?? "");
	if (sourceText.length === 0) {
		return false;
	}

	const blockerPresent = CLIENT_RENDERING_BLOCKER_PATTERNS.some(pattern => pattern.test(sourceText));
	const placeholderCount = emptyPlaceholderCount(candidate);
	if (blockerPresent && (
		sourceText.length <= MAX_STANDALONE_SHELL_TEXT_LENGTH ||
		placeholderCount >= MIN_REPEATED_PLACEHOLDERS
	)) {
		return true;
	}

	if (!candidate.html || sourceText.length > MAX_STRUCTURAL_SHELL_TEXT_LENGTH) {
		return false;
	}
	const scriptCount = candidate.html.match(/<script\b/gi)?.length ?? 0;
	return placeholderCount >= MIN_STRUCTURAL_EMPTY_TARGETS && scriptCount >= MIN_CLIENT_SCRIPT_TAGS;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

function responseTooLargeMessage(maxBytes: number): string {
	return `Response too large (limit ${Math.round(maxBytes / 1024 / 1024)}MB)`;
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = createAbortableLimiter(CONCURRENT_LIMIT);

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
}

export interface ExtractOptions {
	/** Validated settings captured when this content retrieval starts. */
	settings?: Readonly<ContentRetrievalSettings>;
	timeoutMs?: number;
	forceClone?: boolean;
	prompt?: string;
	timestamp?: string;
	frames?: number;
	model?: string;
	/** Startup-validated settings captured for this extraction operation. */
	media?: Readonly<MediaSettings>;
	/** Custom DNS resolver used for SSRF validation. Primarily a test seam. */
	lookup?: Lookup;
}

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

async function extractWithJinaReader(
	url: string,
	signal?: AbortSignal,
	lookup?: Lookup,
	allowRanges: readonly string[] = DEFAULT_WEB_ACCESS_SETTINGS.ssrf.allowRanges,
): Promise<SourceRetrievalResult | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const requestSignal = AbortSignal.any([
			AbortSignal.timeout(JINA_TIMEOUT_MS),
			...(signal ? [signal] : []),
		]);
		await validateRemoteUrl(url, { allowRanges, lookup, signal: requestSignal });
		const res = await fetchOwnedResponse(jinaUrl, {
			headers: {
				"Accept": "text/markdown",
				"X-No-Cache": "true",
			},
		}, requestSignal);

		if (isChallengeCandidate({ headers: res.headers })) {
			await discardResponseBody(res, "Anti-bot challenge detected", requestSignal);
			activityMonitor.logComplete(activityId, res.status);
			return SOURCE_REJECTION.Challenge;
		}

		if (!res.ok) {
			await discardResponseBody(res, "Jina request failed", requestSignal);
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const content = await readResponseText(res, requestSignal, MAX_RESPONSE_BYTES);
		activityMonitor.logComplete(activityId, res.status);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		if (isChallengeCandidate({ markdown: markdownPart })) {
			return SOURCE_REJECTION.Challenge;
		}
		if (isClientRenderedShellCandidate({ markdown: markdownPart })) {
			return SOURCE_REJECTION.ClientRenderedShell;
		}

		// Check for failed JS rendering or minimal content
		if (markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")) {
			return null;
		}

		const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

function parseTimestamp(ts: string): number | null {
	const num = Number(ts);
	if (!isNaN(num) && num >= 0) return Math.floor(num);
	const parts = ts.split(":").map(Number);
	if (parts.some(p => isNaN(p) || p < 0)) return null;
	if (parts.length === 3) {
		const [hours = 0, minutes = 0, seconds = 0] = parts;
		return Math.floor(hours * 3600 + minutes * 60 + seconds);
	}
	if (parts.length === 2) {
		const [minutes = 0, seconds = 0] = parts;
		return Math.floor(minutes * 60 + seconds);
	}
	return null;
}

type TimestampSpec = { type: "single"; seconds: number } | { type: "range"; start: number; end: number };

function parseTimestampSpec(ts: string): TimestampSpec | null {
	const dashIdx = ts.indexOf("-", 1);
	if (dashIdx > 0) {
		const start = parseTimestamp(ts.slice(0, dashIdx));
		const end = parseTimestamp(ts.slice(dashIdx + 1));
		if (start !== null && end !== null && end > start) return { type: "range", start, end };
	}
	const seconds = parseTimestamp(ts);
	return seconds !== null ? { type: "single", seconds } : null;
}

const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL = 5;

function computeRangeTimestamps(start: number, end: number, maxFrames: number = DEFAULT_RANGE_FRAMES): number[] {
	if (maxFrames <= 1) return [start];
	const duration = end - start;
	const idealInterval = duration / (maxFrames - 1);
	if (idealInterval < MIN_FRAME_INTERVAL) {
		const timestamps: number[] = [];
		for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
			timestamps.push(t);
		}
		return timestamps;
	}
	return Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * idealInterval));
}

function buildFrameResult(
	url: string, label: string, requestedCount: number,
	frames: VideoFrame[], error: string | null, duration?: number,
): ExtractedContent {
	if (frames.length === 0) {
		const msg = error ?? "Frame extraction failed";
		return { url, title: `Frames ${label} (0/${requestedCount})`, content: msg, error: msg };
	}
	return {
		url,
		title: `Frames ${label} (${frames.length}/${requestedCount})`,
		content: `${frames.length} frames extracted from ${label}`,
		error: null,
		frames,
		duration,
	};
}

async function extractLocalFrames(
	filePath: string, timestamps: number[],
): Promise<{ frames: VideoFrame[]; error: string | null }> {
	const results = await Promise.all(timestamps.map(async (t) => {
		const frame = await extractVideoFrame(filePath, t);
		if ("error" in frame) return { error: frame.error };
		return { ...frame, timestamp: formatSeconds(t) };
	}));
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const firstError = results.find((f): f is { error: string } => "error" in f);
	return { frames, error: frames.length === 0 && firstError ? firstError.error : null };
}

function safeVideoInfo(url: string, settings: MediaSettings["video"]): { info: ReturnType<typeof isVideoFile>; error?: string } {
	try {
		return { info: isVideoFile(url, settings) };
	} catch (err) {
		return { info: null, error: errorMessage(err) };
	}
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}
	const media = options?.media ?? DEFAULT_MEDIA_SETTINGS;

	if (options?.frames && !options.timestamp) {
		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				return { url, title: "Frames", content: streamInfo.error, error: streamInfo.error };
			}
			if (streamInfo.duration === null) {
				const error = "Cannot determine video duration. Use a timestamp range instead.";
				return { url, title: "Frames", content: error, error };
			}
			const dur = Math.floor(streamInfo.duration);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, streamInfo.duration);
		}

		const localVideo = safeVideoInfo(url, media.video);
		if (localVideo.error) {
			return { url, title: "", content: "", error: localVideo.error };
		}
		if (localVideo.info) {
			const durationResult = await getLocalVideoDuration(localVideo.info.absolutePath);
			if (typeof durationResult !== "number") {
				return { url, title: "Frames", content: durationResult.error, error: durationResult.error };
			}
			const dur = Math.floor(durationResult);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, durationResult);
		}

		return { url, title: "", content: "", error: "Frame extraction only works with YouTube and local video files" };
	}

	if (options?.timestamp) {
		const spec = parseTimestampSpec(options.timestamp);
		if (!spec) {
			return {
				url,
				title: "",
				content: "",
				error: `Invalid timestamp format: "${options.timestamp}". Use "H:MM:SS", "MM:SS", "85", or "start-end".`,
			};
		}

		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				if (spec.type === "range") {
					const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
					return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
				}
				if (frameCount) {
					const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
					const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
					return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
				}
				return { url, title: `Frame at ${options.timestamp}`, content: streamInfo.error, error: streamInfo.error };
			}

			if (spec.type === "range") {
				const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
				if (streamInfo.duration !== null && spec.end > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(spec.end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frames ${label}`, content: error, error };
				}
				const timestamps = frameCount
					? computeRangeTimestamps(spec.start, spec.end, frameCount)
					: computeRangeTimestamps(spec.start, spec.end);
				const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error, result.duration ?? undefined);
			}

			if (frameCount) {
				const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
				const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
				if (streamInfo.duration !== null && end > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frames ${label}`, content: error, error };
				}
				const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
				const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error, result.duration ?? undefined);
			}

			if (streamInfo.duration !== null && spec.seconds > streamInfo.duration) {
				const error = `Timestamp ${formatSeconds(spec.seconds)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
				return { url, title: `Frame at ${options.timestamp}`, content: error, error };
			}
			const frame = await extractYouTubeFrame(ytInfo.videoId, spec.seconds, streamInfo);
			if ("error" in frame) {
				return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
			}
			return { url, title: `Frame at ${options.timestamp}`, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame };
		}

		const localVideo = safeVideoInfo(url, media.video);
		if (localVideo.error) {
			return { url, title: "", content: "", error: localVideo.error };
		}
		if (localVideo.info) {
			if (spec.type === "range") {
				const timestamps = frameCount
					? computeRangeTimestamps(spec.start, spec.end, frameCount)
					: computeRangeTimestamps(spec.start, spec.end);
				const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
				const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
			}

			if (frameCount) {
				const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
				const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
				const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
				const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
			}

			const frame = await extractVideoFrame(localVideo.info.absolutePath, spec.seconds);
			if ("error" in frame) {
				return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
			}
			return { url, title: `Frame at ${options.timestamp}`, content: `Video frame at ${options.timestamp}`, error: null, thumbnail: frame };
		}

		return { url, title: "", content: "", error: "Timestamp extraction only works with YouTube and local video files" };
	}

	const localVideo = safeVideoInfo(url, media.video);
	if (localVideo.error) {
		return { url, title: "", content: "", error: localVideo.error };
	}
	if (localVideo.info) {
		try {
			const result = await extractVideo(localVideo.info, signal, options, media.video);
			if (signal?.aborted) return abortedResult(url);
			return result ?? { url, title: "", content: "", error: `Video analysis requires Gemini access. Either:\n  1. Sign into gemini.google.com in Chrome (free, uses cookies)\n  2. Set GEMINI_API_KEY in ${getWebAccessConfiguration().sourcePath}` };
		} catch (err) {
			if (isAbortError(err)) return abortedResult(url);
			return { url, title: "", content: "", error: errorMessage(err) };
		}
	}

	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			await validateRemoteUrl(parsed, { allowRanges: options?.settings?.ssrf.allowRanges ?? DEFAULT_WEB_ACCESS_SETTINGS.ssrf.allowRanges, lookup: options?.lookup, signal });
		}
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}

	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone, options?.settings?.githubClone ?? DEFAULT_WEB_ACCESS_SETTINGS.githubClone);
		if (ghResult) return ghResult;
		if (signal?.aborted) return abortedResult(url);
	} catch (err) {
		if (isAbortError(err)) return abortedResult(url);
	}

	const ytInfo = isYouTubeURL(url);
	let youtubeEnabled = false;
	try {
		youtubeEnabled = isYouTubeEnabled(media.youtube);
	} catch (err) {
		return { url, title: "", content: "", error: errorMessage(err) };
	}
	if (ytInfo.isYouTube && youtubeEnabled) {
		try {
			const ytResult = await extractYouTube(url, signal, options?.prompt, options?.model, media.youtube);
			if (ytResult) return ytResult;
			if (signal?.aborted) return abortedResult(url);
		} catch (err) {
			const message = errorMessage(err);
			if (isAbortError(err)) return abortedResult(url);
			return { url, title: "", content: "", error: message };
		}
		return {
			url,
			title: "",
			content: "",
			error: "Could not extract YouTube video content. Sign into Google in Chrome for automatic access, or set GEMINI_API_KEY.",
		};
	}

	if (signal?.aborted) {
		return abortedResult(url);
	}

	const httpAttempt = await extractViaHttp(url, signal, options);
	let challengeDetected = httpAttempt === SOURCE_REJECTION.Challenge;
	let clientRenderedShellDetected = httpAttempt === SOURCE_REJECTION.ClientRenderedShell;
	const httpResult: ExtractedContent = httpAttempt === SOURCE_REJECTION.Challenge ||
		httpAttempt === SOURCE_REJECTION.ClientRenderedShell
		? {
			url,
			title: "",
			content: "",
			error: httpAttempt === SOURCE_REJECTION.Challenge
				? "Anti-bot challenge detected"
				: "Client-rendered shell detected",
		}
		: httpAttempt;

	if (signal?.aborted) {
		return abortedResult(url);
	}
	const httpError = httpResult.error;
	if (!httpError) {
		return httpResult;
	}
	if (NON_RECOVERABLE_ERRORS.some(prefix => httpError.startsWith(prefix))) {
		return httpResult;
	}

	const jinaResult = await extractWithJinaReader(url, signal, options?.lookup, options?.settings?.ssrf.allowRanges);
	if (jinaResult === SOURCE_REJECTION.Challenge) {
		challengeDetected = true;
	} else if (jinaResult === SOURCE_REJECTION.ClientRenderedShell) {
		clientRenderedShellDetected = true;
	} else if (jinaResult) {
		return jinaResult;
	}
	if (signal?.aborted) {
		return abortedResult(url);
	}

	let parallelError: string | null = null;
	try {
		const settings = options?.settings ?? {};
		if (isParallelAvailable(settings)) {
			const parallelResult = await extractWithParallel(url, signal, options, settings);
			if (parallelResult) {
				if (isChallengeCandidate({ markdown: parallelResult.content })) {
					challengeDetected = true;
				} else {
					return parallelResult;
				}
			}
		}
	} catch (err) {
		if (isAbortError(err)) {
			return abortedResult(url);
		}
		parallelError = errorMessage(err);
	}
	if (signal?.aborted) {
		return abortedResult(url);
	}

	let geminiResult: ExtractedContent | null = null;
	try {
		geminiResult = await extractWithUrlContext(url, signal)
			?? await extractWithGeminiWeb(url, signal);
	} catch (err) {
		if (isAbortError(err)) {
			return abortedResult(url);
		}
	}

	if (geminiResult) {
		return geminiResult;
	}
	if (signal?.aborted) {
		return abortedResult(url);
	}
	if (challengeDetected) {
		return { url, title: "", content: "", error: BLOCKED_CONTENT_ERROR };
	}
	if (clientRenderedShellDetected) {
		return { url, title: "", content: "", error: CLIENT_RENDERED_SHELL_ERROR };
	}

	const guidance = [
		httpError,
		...(parallelError ? [`Parallel fallback failed: ${parallelError}`] : []),
		"",
		"Fallback options:",
		`  \u2022 Set PARALLEL_API_KEY in ${getWebAccessConfiguration().sourcePath}`,
		`  \u2022 Set GEMINI_API_KEY in ${getWebAccessConfiguration().sourcePath}`,
		"  \u2022 Sign into gemini.google.com in Chrome",
		"  \u2022 Use web_search to find content about this topic",
	].join("\n");
	return { ...httpResult, error: guidance };
}

function isLikelyJSRendered(html: string): boolean {
	// Extract body content
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1];
	if (bodyHtml === undefined) return false;

	const textContent = htmlText(bodyHtml);

	// Count scripts
	const scriptCount = (html.match(/<script/gi) || []).length;

	// Heuristic: little text content but many scripts suggests JS rendering
	return textContent.length < 500 && scriptCount > 3;
}

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<SourceRetrievalResult> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetchRemoteUrl(
			url,
			{
				signal: controller.signal,
				headers: {
					"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Cache-Control": "no-cache",
					"Sec-Fetch-Dest": "document",
					"Sec-Fetch-Mode": "navigate",
					"Sec-Fetch-Site": "none",
					"Sec-Fetch-User": "?1",
					"Upgrade-Insecure-Requests": "1",
				},
			},
			{ allowRanges: options?.settings?.ssrf.allowRanges ?? DEFAULT_WEB_ACCESS_SETTINGS.ssrf.allowRanges, lookup: options?.lookup, signal: controller.signal },
		);

		if (isChallengeCandidate({ headers: response.headers })) {
			await discardResponseBody(response, "Anti-bot challenge detected", controller.signal);
			activityMonitor.logComplete(activityId, response.status);
			return SOURCE_REJECTION.Challenge;
		}

		if (!response.ok) {
			await discardResponseBody(response, "HTTP request failed", controller.signal);
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const isDocumentContent = isConvertibleDocument(url, contentType);
		const maxResponseBytes = isDocumentContent ? MAX_DOCUMENT_RESPONSE_BYTES : MAX_RESPONSE_BYTES;
		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxResponseBytes) {
				await discardResponseBody(response, "Response exceeded the content limit", controller.signal);
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (isDocumentContent) {
			try {
				const bytes = await readResponseBytes(response, controller.signal, maxResponseBytes);
				const result = await convertDocument(bytes, url, contentType);
				controller.signal.throwIfAborted();
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title || extractTextTitle(result.markdown, url),
					content: result.markdown,
					error: null,
				};
			} catch (err) {
				if (err instanceof ResponseBodyTooLargeError) {
					activityMonitor.logError(activityId, err.message);
					return { url, title: "", content: "", error: responseTooLargeMessage(err.limitBytes) };
				}
				if (controller.signal.aborted) throw err;
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: `Document extraction failed: ${message}` };
			}
		}

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			await discardResponseBody(response, "Unsupported content type", controller.signal);
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = new TextDecoder().decode(await readResponseBytes(response, controller.signal, maxResponseBytes));
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (isHTML && isChallengeCandidate({ html: text })) {
			activityMonitor.logComplete(activityId, response.status);
			return SOURCE_REJECTION.Challenge;
		}
		if (isHTML && isClientRenderedShellCandidate({ html: text })) {
			activityMonitor.logComplete(activityId, response.status);
			return SOURCE_REJECTION.ClientRenderedShell;
		}

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			if (isChallengeCandidate({ markdown: text })) {
				return SOURCE_REJECTION.Challenge;
			}
			if (isClientRenderedShellCandidate({ markdown: text })) {
				return SOURCE_REJECTION.ClientRenderedShell;
			}
			const title = extractTextTitle(text, url);
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult) {
				activityMonitor.logComplete(activityId, response.status);
				if (isChallengeCandidate({ markdown: rscResult.content })) {
					return SOURCE_REJECTION.Challenge;
				}
				if (isClientRenderedShellCandidate({ markdown: rscResult.content })) {
					return SOURCE_REJECTION.ClientRenderedShell;
				}
				return { url, title: rscResult.title, content: rscResult.content, error: null };
			}

			activityMonitor.logComplete(activityId, response.status);

			// Provide more specific error message
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: "",
				content: "",
				error: errorMsg,
			};
		}

		const markdown = turndown.turndown(article.content ?? "");
		activityMonitor.logComplete(activityId, response.status);

		if (isChallengeCandidate({ markdown })) {
			return SOURCE_REJECTION.Challenge;
		}
		if (isClientRenderedShellCandidate({ markdown })) {
			return SOURCE_REJECTION.ClientRenderedShell;
		}
		if (markdown.length < MIN_USEFUL_CONTENT) {
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content is too sparse to accept",
			};
		}

		return { url, title: article.title || "", content: markdown, error: null };
	} catch (err) {
		if (err instanceof ResponseBodyTooLargeError) {
			activityMonitor.logError(activityId, err.message);
			return { url, title: "", content: "", error: responseTooLargeMessage(err.limitBytes) };
		}
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const heading = match[1];
	if (heading === undefined) return null;
	const cleaned = heading.replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

function fetchLimitedContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	return fetchLimit.run(async () => {
		if (signal?.aborted) return abortedResult(url);
		try {
			return await extractContent(url, signal, options);
		} catch (error) {
			if (signal?.aborted) return abortedResult(url);
			throw error;
		}
	}, signal);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimitedContent(url, signal, options)));
}
