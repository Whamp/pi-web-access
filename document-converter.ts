import { Markit } from "markit-ai";

interface DocumentConversion {
	markdown: string;
	title?: string;
}

interface DocumentInfo {
	extension: string;
	filename: string;
	mimetype: string;
}

const MIME_EXTENSIONS = new Map<string, string>([
	["application/pdf", ".pdf"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
	["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
]);
const DOCUMENT_EXTENSIONS = new Set(MIME_EXTENSIONS.values());
const ZIP_MIMETYPES = new Set(["application/octet-stream", "application/zip"]);
const MARKIT = new Markit();

/** Reports whether an HTTP response should be handled as a supported document. */
export function isConvertibleDocument(url: string, contentType: string): boolean {
	const mimetype = normalizeMimetype(contentType);
	if (MIME_EXTENSIONS.has(mimetype)) {
		return true;
	}

	const extension = extensionFromUrl(url);
	return DOCUMENT_EXTENSIONS.has(extension) && (mimetype === "" || ZIP_MIMETYPES.has(mimetype));
}

/** Reports whether a supported document receives the larger PDF byte limit. */
export function isPdfDocument(url: string, contentType: string): boolean {
	const mimetype = normalizeMimetype(contentType);
	if (MIME_EXTENSIONS.get(mimetype) === ".pdf") {
		return true;
	}
	return extensionFromUrl(url) === ".pdf" && (mimetype === "" || ZIP_MIMETYPES.has(mimetype));
}

/** Converts an already-retrieved supported document into Markdown. */
export async function convertDocument(
	bytes: Uint8Array,
	url: string,
	contentType: string,
): Promise<DocumentConversion> {
	const info = documentInfo(url, contentType);
	validateSignature(bytes, info.extension);
	const result = await MARKIT.convert(Buffer.from(bytes), info);
	return result.title === undefined
		? { markdown: result.markdown }
		: { markdown: result.markdown, title: result.title };
}

function documentInfo(url: string, contentType: string): DocumentInfo {
	const mimetype = normalizeMimetype(contentType);
	const extension = MIME_EXTENSIONS.get(mimetype) ?? extensionFromUrl(url);
	if (!DOCUMENT_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported document type: ${mimetype || extension || "unknown"}`);
	}

	const filename = filenameFromUrl(url, extension);
	return { extension, filename, mimetype: mimetype || mimetypeForExtension(extension) };
}

function validateSignature(bytes: Uint8Array, extension: string): void {
	if (extension === ".pdf") {
		if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
			return;
		}
		throw new Error("Invalid PDF document signature");
	}

	const hasZipSignature = bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		((bytes[2] === 0x03 && bytes[3] === 0x04) ||
			(bytes[2] === 0x05 && bytes[3] === 0x06) ||
			(bytes[2] === 0x07 && bytes[3] === 0x08));
	if (!hasZipSignature) {
		throw new Error(`Invalid ${extension.slice(1).toUpperCase()} document signature`);
	}
}

function normalizeMimetype(contentType: string): string {
	return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function extensionFromUrl(url: string): string {
	try {
		const filename = new URL(url).pathname.split("/").pop() ?? "";
		const dot = filename.lastIndexOf(".");
		return dot < 0 ? "" : filename.slice(dot).toLowerCase();
	} catch {
		return "";
	}
}

function filenameFromUrl(url: string, extension: string): string {
	try {
		const filename = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
		return filename || `document${extension}`;
	} catch {
		return `document${extension}`;
	}
}

function mimetypeForExtension(extension: string): string {
	for (const [mimetype, candidate] of MIME_EXTENSIONS) {
		if (candidate === extension) {
			return mimetype;
		}
	}
	return "application/octet-stream";
}
