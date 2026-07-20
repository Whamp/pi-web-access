import { Markit } from "markit-ai";

interface DocumentConversion {
	markdown: string;
	title?: string;
}

interface DocumentInfo {
	extension: string;
	filename: string;
	mimeType: string;
}

const MIME_TYPE_EXTENSIONS = new Map<string, string>([
	["application/pdf", ".pdf"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
	["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
]);
const DOCUMENT_EXTENSIONS = new Set(MIME_TYPE_EXTENSIONS.values());
const GENERIC_ZIP_MIME_TYPES = new Set(["application/octet-stream", "application/zip"]);
const MARKIT = new Markit();

/** Reports whether an HTTP response should be handled as a supported document. */
export function isConvertibleDocument(url: string, contentType: string): boolean {
	return resolveDocumentExtension(url, contentType) !== null;
}

/** Converts an already-retrieved supported document into Markdown. */
export async function convertDocument(
	bytes: Uint8Array,
	url: string,
	contentType: string,
): Promise<DocumentConversion> {
	const info = documentInfo(url, contentType);
	const result = await MARKIT.convert(Buffer.from(bytes), {
		extension: info.extension,
		filename: info.filename,
		mimetype: info.mimeType,
	});
	return result.title === undefined
		? { markdown: result.markdown }
		: { markdown: result.markdown, title: result.title };
}

function documentInfo(url: string, contentType: string): DocumentInfo {
	const extension = resolveDocumentExtension(url, contentType);
	if (extension === null) {
		throw new Error(`Unsupported document type: ${normalizeMimeType(contentType) || extensionFromUrl(url) || "unknown"}`);
	}

	const mimeType = normalizeMimeType(contentType) || mimeTypeForExtension(extension);
	return { extension, filename: filenameFromUrl(url, extension), mimeType };
}

function resolveDocumentExtension(url: string, contentType: string): string | null {
	const mimeType = normalizeMimeType(contentType);
	const mimeTypeExtension = MIME_TYPE_EXTENSIONS.get(mimeType);
	if (mimeTypeExtension !== undefined) {
		return mimeTypeExtension;
	}

	const urlExtension = extensionFromUrl(url);
	if (DOCUMENT_EXTENSIONS.has(urlExtension) && (mimeType === "" || GENERIC_ZIP_MIME_TYPES.has(mimeType))) {
		return urlExtension;
	}
	return null;
}

function normalizeMimeType(contentType: string): string {
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

function mimeTypeForExtension(extension: string): string {
	for (const [mimeType, candidate] of MIME_TYPE_EXTENSIONS) {
		if (candidate === extension) {
			return mimeType;
		}
	}
	return "application/octet-stream";
}
