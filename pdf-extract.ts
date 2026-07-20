/**
 * PDF Content Extractor
 * 
 * Extracts text from PDF files and saves to markdown.
 * Uses unpdf (pdfjs-dist wrapper) for text extraction.
 */

import { getResolvedPDFJS } from "unpdf";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import { abortReason } from "./abort.ts";

export interface PDFExtractResult {
  title: string;
  pages: number;
  chars: number;
  outputPath: string;
}

export interface PDFExtractOptions {
  maxPages?: number;
  outputDir?: string;
  filename?: string;
  signal?: AbortSignal;
}

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_OUTPUT_DIR = join(homedir(), "Downloads");

/**
 * Extract text from a PDF buffer and save to markdown file
 */
export async function extractPDFToMarkdown(
  buffer: ArrayBuffer,
  url: string,
  options: PDFExtractOptions = {}
): Promise<PDFExtractResult> {
  const {
    maxPages = DEFAULT_MAX_PAGES,
    outputDir = DEFAULT_OUTPUT_DIR,
    filename,
    signal,
  } = options;

  const safeMaxPages = Number.isFinite(maxPages)
    ? Math.max(1, Math.floor(maxPages))
    : DEFAULT_MAX_PAGES;

  signal?.throwIfAborted();
  const pdfjs = await getResolvedPDFJS();
  signal?.throwIfAborted();
  let standardFontDataUrl: string | undefined;
  try {
    const pdfjsPackage = import.meta.resolve("pdfjs-dist/package.json");
    standardFontDataUrl = new URL("./standard_fonts/", pdfjsPackage).href;
  } catch {
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    ...(standardFontDataUrl ? { disableFontFace: true, standardFontDataUrl } : {}),
  });
  let cleanup: Promise<void> | undefined;
  const destroy = (): Promise<void> => {
    cleanup ??= Promise.resolve(loadingTask.destroy());
    return cleanup;
  };
  const onAbort = (): void => {
    void destroy().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const pdf = await loadingTask.promise;
    signal?.throwIfAborted();
    const metadata = await pdf.getMetadata();
    signal?.throwIfAborted();
    const metadataInfo = metadata.info && typeof metadata.info === "object"
      ? metadata.info as Record<string, unknown>
      : null;

    // Extract title from metadata or URL
    const metaTitle = typeof metadataInfo?.Title === "string" ? metadataInfo.Title : undefined;
    const metaAuthor = typeof metadataInfo?.Author === "string" ? metadataInfo.Author : undefined;
    const urlTitle = extractTitleFromURL(url);
    const title = metaTitle?.trim() || urlTitle;

    // Determine pages to extract
    const pagesToExtract = Math.min(pdf.numPages, safeMaxPages);
    const truncated = pdf.numPages > safeMaxPages;

    // Extract text page by page for better structure
    const pages: { pageNum: number; text: string }[] = [];
    for (let i = 1; i <= pagesToExtract; i++) {
      const page = await pdf.getPage(i);
      signal?.throwIfAborted();
      const textContent = await page.getTextContent();
      signal?.throwIfAborted();
      const pageText = textContent.items
        .map((item: unknown) => {
          const textItem = item as { str?: string };
          return textItem.str || "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (pageText) {
        pages.push({ pageNum: i, text: pageText });
      }
    }

    // Build markdown content
    const lines: string[] = [];

    // Header with metadata
    lines.push(`# ${title}`);
    lines.push("");
    lines.push(`> Source: ${url}`);
    lines.push(`> Pages: ${pdf.numPages}${truncated ? ` (extracted first ${pagesToExtract})` : ""}`);
    if (metaAuthor) {
      lines.push(`> Author: ${metaAuthor}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");

    // Content with page markers
    for (const [index, page] of pages.entries()) {
      if (index > 0) {
        lines.push("");
        lines.push(`<!-- Page ${page.pageNum} -->`);
        lines.push("");
      }
      lines.push(page.text);
    }

    if (truncated) {
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(`*[Truncated: Only first ${pagesToExtract} of ${pdf.numPages} pages extracted]*`);
    }

    const content = lines.join("\n");

    // Generate output filename
    const outputFilename = filename || sanitizeFilename(title) + ".md";
    const outputPath = join(outputDir, outputFilename);

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });
    signal?.throwIfAborted();

    // Write file
    await writeFile(outputPath, content, { encoding: "utf-8", signal });
    signal?.throwIfAborted();
    const result = {
      title,
      pages: pdf.numPages,
      chars: content.length,
      outputPath,
    };
    await destroy();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) {
      await destroy().catch(() => {});
      throw abortReason(signal);
    }
    await destroy().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Extract a reasonable title from URL
 */
function extractTitleFromURL(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Get filename without extension
    let filename = basename(pathname, ".pdf");
    
    // Handle arxiv URLs: /pdf/1706.03762 → "arxiv-1706.03762"
    if (urlObj.hostname.includes("arxiv.org")) {
      const match = pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
      if (match) {
        filename = `arxiv-${match[1]}`;
      }
    }
    
    // Clean up filename
    filename = filename
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    
    return filename || "document";
  } catch {
    return "document";
  }
}

/**
 * Sanitize string for use as filename
 */
function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100)
    .replace(/^-|-$/g, "")
    || "document";
}

/**
 * Check if URL or content-type indicates a PDF
 */
export function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) {
    return true;
  }
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}
