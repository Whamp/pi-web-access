import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_MEDIA_SETTINGS, type MediaSettings } from "./configuration.ts";
import { activityMonitor } from "./activity.ts";
import { settleWithAbort } from "./abort.ts";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.ts";
import { isGeminiApiAvailable, queryGeminiApiWithVideo } from "./gemini-api.ts";
import { isPerplexityAvailable, searchWithPerplexity } from "./perplexity.ts";
import { extractHeadingTitle, type ExtractedContent, type FrameResult, type VideoFrame } from "./extract.ts";
import {
	abandonResponseBody,
	discardResponseBody,
	fetchOwnedResponse,
	readResponseBytes,
	readResponseText,
} from "./response-body.ts";
import { formatSeconds, readExecError, isTimeoutError, trimErrorText, mapFfmpegError } from "./utils.ts";

const YOUTUBE_PROMPT = `Extract the complete content of this YouTube video. Include:
1. Video title, channel name, and duration
2. A brief summary (2-3 sentences)
3. Full transcript with timestamps
4. Descriptions of any code, terminal commands, diagrams, slides, or UI shown on screen

Format as markdown.`;

const YOUTUBE_REGEX =
	/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
const execFileAsync = promisify(execFile);
const YT_DLP_TRANSCRIPT_TIMEOUT_MS = 30_000;
const YOUTUBE_CAPTION_TIMEOUT_MS = 15_000;
const MAX_YOUTUBE_CAPTION_BYTES = 5 * 1024 * 1024;

interface YouTubeCaptionTrack {
	url: string;
	headers: Headers;
}

interface YouTubeTranscriptMetadata {
	title: string;
	channel: string;
	publicationDate: string;
	durationSeconds: number | null;
	caption: YouTubeCaptionTrack | null;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function shouldRethrow(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function addAttemptError(errors: string[], label: string, err: unknown): void {
	const message = errorMessage(err).replace(/\s+/g, " ").trim();
	if (message) errors.push(`${label}: ${message}`);
}

export function isYouTubeURL(url: string): { isYouTube: boolean; videoId: string | null } {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/playlist") {
			return { isYouTube: false, videoId: null };
		}
	} catch {
	}

	const videoId = url.match(YOUTUBE_REGEX)?.[1];
	if (videoId === undefined) return { isYouTube: false, videoId: null };
	return { isYouTube: true, videoId };
}

export function isYouTubeEnabled(settings: MediaSettings["youtube"] = DEFAULT_MEDIA_SETTINGS.youtube): boolean {
	return settings.enabled;
}

export async function extractYouTube(
	url: string,
	signal?: AbortSignal,
	prompt?: string,
	model?: string,
	settings: MediaSettings["youtube"] = DEFAULT_MEDIA_SETTINGS.youtube,
): Promise<ExtractedContent | null> {
	const { videoId } = isYouTubeURL(url);
	const canonicalUrl = videoId
		? `https://www.youtube.com/watch?v=${videoId}`
		: url;
	const effectivePrompt = prompt ?? YOUTUBE_PROMPT;
	const effectiveModel = model ?? settings.preferredModel;

	const activityId = activityMonitor.logStart({ type: "fetch", url: `youtube.com/${videoId ?? "video"}` });
	const attemptErrors: string[] = [];

	const geminiResult = await tryGeminiWeb(canonicalUrl, effectivePrompt, effectiveModel, signal, attemptErrors)
		?? await tryGeminiApi(canonicalUrl, effectivePrompt, effectiveModel, signal, attemptErrors);
	const publicTranscriptResult = await tryYtDlpTranscript(canonicalUrl, signal, attemptErrors);
	const result = combineYouTubeSourceResults(geminiResult, publicTranscriptResult)
		?? await tryPerplexity(url, effectivePrompt, signal, attemptErrors);

	if (result) {
		result.url = url;
		if (!result.error && videoId) {
			const thumb = await fetchYouTubeThumbnail(videoId, signal);
			if (signal?.aborted) {
				activityMonitor.logComplete(activityId, 0);
				return null;
			}
			if (thumb) result.thumbnail = thumb;
		}
		activityMonitor.logComplete(activityId, result.error ? 0 : 200);
		return result;
	}

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	const error = attemptErrors.length > 0
		? ["Could not extract YouTube video content.", "", ...attemptErrors.map(message => `- ${message}`)].join("\n")
		: "Could not extract YouTube video content. Sign into Google in Chrome for automatic access, or set GEMINI_API_KEY.";
	activityMonitor.logError(activityId, error);
	return { url, title: "", content: "", error };
}

function combineYouTubeSourceResults(
	geminiResult: ExtractedContent | null,
	publicTranscriptResult: ExtractedContent | null,
): ExtractedContent | null {
	if (geminiResult && publicTranscriptResult) {
		return {
			...geminiResult,
			title: publicTranscriptResult.title,
			duration: publicTranscriptResult.duration,
			content: [
				"# YouTube Video Analysis and Public Transcript",
				"",
				"## Gemini Video Analysis",
				"",
				geminiResult.content.trim(),
				"",
				"---",
				"",
				publicTranscriptResult.content.trim(),
			].join("\n"),
		};
	}
	if (geminiResult) {
		return {
			...geminiResult,
			content: [
				geminiResult.content.trim(),
				"",
				"---",
				"",
				"## Public Transcript Unavailable",
				"",
				"Public metadata and captions were unavailable, so the Gemini analysis above may not contain a complete transcript.",
			].join("\n"),
		};
	}
	if (publicTranscriptResult) {
		return {
			...publicTranscriptResult,
			content: [
				publicTranscriptResult.content.trim(),
				"",
				"---",
				"",
				"## Gemini Video Analysis Unavailable",
				"",
				"Gemini video analysis was unavailable. This result contains public metadata and captions, but may omit visual context.",
			].join("\n"),
		};
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseYouTubePublicationDate(value: unknown): string {
	if (typeof value !== "string" || !/^\d{8}$/.test(value)) return "Unknown";
	return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function parseYouTubeCaptionTrack(value: unknown): YouTubeCaptionTrack | null {
	if (!isRecord(value) || typeof value.url !== "string") return null;
	const headers = new Headers();
	if (isRecord(value.http_headers)) {
		for (const [name, headerValue] of Object.entries(value.http_headers)) {
			if (typeof headerValue === "string") headers.set(name, headerValue);
		}
	}
	return { url: value.url, headers };
}

function parseYtDlpTranscriptMetadata(output: string): YouTubeTranscriptMetadata {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch (error) {
		throw new Error("Failed to parse yt-dlp metadata output", { cause: error });
	}
	if (!isRecord(value) || typeof value.title !== "string") {
		throw new Error("Failed to parse yt-dlp metadata: missing video title");
	}

	const requestedSubtitles = isRecord(value.requested_subtitles) ? value.requested_subtitles : {};
	const caption = parseYouTubeCaptionTrack(requestedSubtitles.en)
		?? Object.values(requestedSubtitles).map(parseYouTubeCaptionTrack).find(track => track !== null)
		?? null;
	return {
		title: value.title,
		channel: typeof value.channel === "string" ? value.channel : "Unknown",
		publicationDate: parseYouTubePublicationDate(value.upload_date),
		durationSeconds: typeof value.duration === "number" && Number.isFinite(value.duration)
			? value.duration
			: null,
		caption,
	};
}

function parseYouTubeJson3Transcript(output: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch (error) {
		throw new Error("Failed to parse YouTube JSON3 captions", { cause: error });
	}
	if (!isRecord(value) || !Array.isArray(value.events)) {
		throw new Error("Failed to parse YouTube JSON3 captions: missing events");
	}

	const transcript: string[] = [];
	for (const eventValue of value.events) {
		if (!isRecord(eventValue) || typeof eventValue.tStartMs !== "number" || !Array.isArray(eventValue.segs)) {
			continue;
		}
		const text = eventValue.segs
			.map(segment => isRecord(segment) && typeof segment.utf8 === "string" ? segment.utf8 : "")
			.join("")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;
		const timestamp = formatSeconds(Math.max(0, Math.floor(eventValue.tStartMs / 1000)));
		transcript.push(`[${timestamp}] ${text}`);
	}
	if (transcript.length === 0) {
		throw new Error("Failed to parse YouTube JSON3 captions: transcript is empty");
	}
	return transcript;
}

function renderYouTubeTranscript(metadata: YouTubeTranscriptMetadata, transcript: string[]): string {
	const duration = metadata.durationSeconds === null
		? "Unknown"
		: formatSeconds(Math.max(0, Math.floor(metadata.durationSeconds)));
	return [
		`# ${metadata.title}`,
		"",
		`**Channel:** ${metadata.channel}`,
		`**Published:** ${metadata.publicationDate}`,
		`**Duration:** ${duration}`,
		"",
		"## Transcript",
		"",
		...transcript,
	].join("\n");
}

async function fetchYouTubeCaptionTrack(
	track: YouTubeCaptionTrack,
	signal?: AbortSignal,
): Promise<string[]> {
	const timeoutSignal = AbortSignal.timeout(YOUTUBE_CAPTION_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const response = await fetchOwnedResponse(track.url, { headers: track.headers }, requestSignal);
	if (!response.ok) {
		await discardResponseBody(response, "YouTube caption request failed", requestSignal);
		throw new Error(`YouTube caption request failed with HTTP ${response.status}`);
	}
	const output = await readResponseText(response, requestSignal, MAX_YOUTUBE_CAPTION_BYTES);
	return parseYouTubeJson3Transcript(output);
}

async function tryYtDlpTranscript(
	url: string,
	signal: AbortSignal | undefined,
	attemptErrors: string[],
): Promise<ExtractedContent | null> {
	try {
		if (signal?.aborted) return null;
		let stdout: string;
		try {
			const result = await execFileAsync("yt-dlp", [
				"--no-warnings",
				"--no-playlist",
				"--skip-download",
				"--write-subs",
				"--write-auto-subs",
				"--sub-langs", "en",
				"--sub-format", "json3",
				"--print", "%(.{title,channel,upload_date,duration,requested_subtitles})#j",
				url,
			], {
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				timeout: YT_DLP_TRANSCRIPT_TIMEOUT_MS,
				signal,
			});
			stdout = result.stdout;
		} catch (error) {
			throw new Error(mapYtDlpError(error), { cause: error });
		}

		const metadata = parseYtDlpTranscriptMetadata(stdout);
		if (!metadata.caption) {
			throw new Error("yt-dlp found no English captions for this video");
		}
		const transcript = await fetchYouTubeCaptionTrack(metadata.caption, signal);
		return {
			url,
			title: metadata.title,
			content: renderYouTubeTranscript(metadata, transcript),
			error: null,
			duration: metadata.durationSeconds ?? undefined,
		};
	} catch (err) {
		if (!signal?.aborted) addAttemptError(attemptErrors, "Public transcript", err);
		return null;
	}
}

type StreamInfo = { streamUrl: string; duration: number | null };
type StreamResult = StreamInfo | { error: string };

function mapYtDlpError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "yt-dlp is not installed. Install with: brew install yt-dlp";
	if (isTimeoutError(err)) return "yt-dlp timed out fetching video info";
	const lower = stderr.toLowerCase();
	if (lower.includes("private")) return "Video is private or unavailable";
	if (lower.includes("sign in")) return "Video is age-restricted and requires authentication";
	if (lower.includes("not available")) return "Video is unavailable in your region or has been removed";
	if (lower.includes("live")) return "Cannot extract frames from a live stream";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `yt-dlp failed: ${snippet}` : "yt-dlp failed";
}

export async function getYouTubeStreamInfo(videoId: string): Promise<StreamResult> {
	try {
		const output = execFileSync("yt-dlp", [
			"--print", "duration",
			"-g", `https://www.youtube.com/watch?v=${videoId}`,
		], { timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		const lines = output.split(/\r?\n/);
		const rawDuration = lines[0]?.trim();
		const streamUrl = lines[1]?.trim();
		if (!streamUrl) return { error: "yt-dlp failed: missing stream URL" };
		const parsedDuration = rawDuration && rawDuration !== "NA" ? Number.parseFloat(rawDuration) : NaN;
		const duration = Number.isFinite(parsedDuration) ? parsedDuration : null;
		return { streamUrl, duration };
	} catch (err) {
		return { error: mapYtDlpError(err) };
	}
}

async function extractFrameFromStream(streamUrl: string, seconds: number): Promise<FrameResult> {
	try {
		const buffer = execFileSync("ffmpeg", [
			"-ss", String(seconds), "-i", streamUrl,
			"-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
		], { maxBuffer: 5 * 1024 * 1024, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
		if (buffer.length === 0) return { error: "ffmpeg failed: empty output" };
		return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
	} catch (err) {
		return { error: mapFfmpegError(err) };
	}
}

export async function extractYouTubeFrame(
	videoId: string,
	seconds: number,
	streamInfo?: StreamInfo,
): Promise<FrameResult> {
	const info = streamInfo ?? await getYouTubeStreamInfo(videoId);
	if ("error" in info) return info;
	return extractFrameFromStream(info.streamUrl, seconds);
}

export async function extractYouTubeFrames(
	videoId: string,
	timestamps: number[],
	streamInfo?: StreamInfo,
): Promise<{ frames: VideoFrame[]; duration: number | null; error: string | null }> {
	const info = streamInfo ?? await getYouTubeStreamInfo(videoId);
	if ("error" in info) return { frames: [], duration: null, error: info.error };
	const results = await Promise.all(timestamps.map(async (t) => {
		const frame = await extractFrameFromStream(info.streamUrl, t);
		if ("error" in frame) return { error: frame.error };
		return { ...frame, timestamp: formatSeconds(t) };
	}));
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const errorResult = results.find((f): f is { error: string } => "error" in f);
	return { frames, duration: info.duration, error: frames.length === 0 && errorResult ? errorResult.error : null };
}

export async function fetchYouTubeThumbnail(
	videoId: string,
	signal?: AbortSignal,
): Promise<{ data: string; mimeType: string } | null> {
	const timeoutSignal = AbortSignal.timeout(5000);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const res = await settleWithAbort(
			() => fetch(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, { signal: requestSignal }),
			requestSignal,
			lateResponse => abandonResponseBody(lateResponse, "YouTube thumbnail arrived after cancellation"),
		);
		if (!res.ok) {
			await discardResponseBody(res, "YouTube thumbnail request failed", requestSignal);
			return null;
		}
		const buffer = Buffer.from(await readResponseBytes(res, requestSignal));
		if (buffer.length === 0) return null;
		return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
	} catch {
		return null;
	}
}

async function tryGeminiWeb(
	url: string,
	prompt: string,
	model: string,
	signal: AbortSignal | undefined,
	attemptErrors: string[],
): Promise<ExtractedContent | null> {
	try {
		const cookies = await isGeminiWebAvailable();
		if (!cookies) return null;

		if (signal?.aborted) return null;

		const text = await queryWithCookies(prompt, cookies, {
			youtubeUrl: url,
			model,
			signal,
			timeoutMs: 120000,
		});

		return {
			url,
			title: extractHeadingTitle(text) ?? "YouTube Video",
			content: text,
			error: null,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		if (!signal?.aborted) addAttemptError(attemptErrors, "Gemini Web", err);
		return null;
	}
}

async function tryGeminiApi(
	url: string,
	prompt: string,
	model: string,
	signal: AbortSignal | undefined,
	attemptErrors: string[],
): Promise<ExtractedContent | null> {
	try {
		if (!isGeminiApiAvailable()) return null;

		if (signal?.aborted) return null;

		const text = await queryGeminiApiWithVideo(prompt, url, {
			model,
			signal,
			timeoutMs: 120000,
		});

		return {
			url,
			title: extractHeadingTitle(text) ?? "YouTube Video",
			content: text,
			error: null,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		if (!signal?.aborted) addAttemptError(attemptErrors, "Gemini API", err);
		return null;
	}
}

async function tryPerplexity(
	url: string,
	prompt: string,
	signal: AbortSignal | undefined,
	attemptErrors: string[],
): Promise<ExtractedContent | null> {
	try {
		if (signal?.aborted || !isPerplexityAvailable()) return null;

		const perplexityQuery = prompt === YOUTUBE_PROMPT
			? `Summarize this YouTube video in detail: ${url}`
			: `${prompt} YouTube video: ${url}`;

		const { answer } = await searchWithPerplexity(
			perplexityQuery,
			{ signal },
		);

		if (!answer) return null;

		const content =
			`# Video Summary (via Perplexity)\n\n${answer}\n\n` +
			`*Full video understanding requires Gemini access. Set GEMINI_API_KEY or sign into Google in Chrome.*`;

		return {
			url,
			title: "Video Summary (via Perplexity)",
			content,
			error: null,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		if (!signal?.aborted) addAttemptError(attemptErrors, "Perplexity", err);
		return null;
	}
}
