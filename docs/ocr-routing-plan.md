# Task-routed local OCR integration plan

**Status:** Proposal  
**Scope:** Optional local OCR for `fetch_content`  
**Default behavior:** Unchanged unless OCR is explicitly configured and enabled

## Summary

Add an opt-in OCR router with two task-specific local backends:

- **OvisOCR2** for Chromium-rendered webpages and direct webpage-like images.
- **PaddleOCR-VL-1.6 full document pipeline** for scanned or image-only PDFs.

The extension will call services that the user runs and configures. It will not download models, start model processes, or require OCR dependencies when OCR is disabled.

This should remain a routed design rather than a generic single-model OCR setting. The two paths solve different extraction problems:

| Input/task | Preferred route | Reason |
| --- | --- | --- |
| Normal HTML page | Existing HTTP / Readability / RSC extraction | Fastest and preserves exact links and text |
| HTML that remains unreadable after existing fallbacks | Render with Chromium, then OvisOCR2 | End-to-end page image to Markdown and page-level reading order |
| Direct screenshot or webpage image | OvisOCR2 | Same visual-page extraction task without browser rendering |
| Text-bearing PDF | Existing `convertDocument` result | Native text is faster and more exact than OCR |
| Scanned or image-only PDF | PaddleOCR-VL-1.6 full pipeline | Layout analysis plus region recognition is aligned with document parsing |
| Difficult visual page after specialized OCR fails | Existing hosted fallbacks or a future configured VLM fallback | Keep the first implementation focused |

Relevant model resources:

- OvisOCR2: https://huggingface.co/ATH-MaaS/OvisOCR2
- Bartowski OvisOCR2 GGUFs: https://huggingface.co/bartowski/ATH-MaaS_OvisOCR2-GGUF
- PaddleOCR-VL-1.6 official GGUF: https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF
- PaddleOCR-VL pipeline documentation: https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.md

## Goals

1. Recover useful Markdown from webpages that defeat HTTP, Readability, RSC, and reader-style extraction.
2. Recover structured content from scanned PDFs without OCRing ordinary text PDFs.
3. Keep OCR fully optional and preserve behavior for existing users.
4. Support user-managed local services over HTTP, including llama.cpp-compatible endpoints.
5. Route by task rather than implying that all OCR models have the same strengths.
6. Preserve cancellation, timeouts, response limits, SSRF protections, and useful diagnostics.
7. Return provenance so agents can distinguish native text from probabilistic OCR.

## Non-goals

- Starting, stopping, downloading, or updating OCR models.
- Bundling a Chromium binary.
- Replacing the existing extraction chain.
- Login automation, clicking, form submission, CAPTCHA handling, or general browser control.
- Reconstructing every interactive element of a webpage.
- Adding hosted OCR providers in the first implementation.
- Treating PaddleOCR-VL's raw GGUF endpoint as equivalent to its full document pipeline.

## Current integration points

The existing retrieval chain in `extract.ts` is:

```text
extractViaHttp
    |
    +-- Readability / RSC / document conversion
    |
    v
Jina Reader
    |
    v
Parallel fallback
    |
    v
Gemini URL-context / Gemini Web
```

Important current behavior:

- `image/*` responses are rejected as unsupported.
- `Unsupported content type` is considered non-recoverable, so direct images do not reach later fallbacks.
- Convertible documents are sent through `convertDocument` and returned with `error: null`, even when a future quality gate may decide that the result is too sparse.
- HTML shorter than `MIN_USEFUL_CONTENT` is returned as a recoverable incomplete result.
- Configuration is startup-validated and immutable through `configuration.ts`.
- `fetch-params.ts` is the normalization layer for `fetch_content` options.

OCR should be inserted without changing these defaults when it is disabled.

## Proposed user-facing behavior

### Extraction mode

Add an optional mode to `fetch_content`:

```ts
type ExtractionMode = "auto" | "text" | "visual";
```

- `auto` remains the default. Existing semantic extraction runs before OCR.
- `text` disables OCR for that call.
- `visual` explicitly requests the configured visual route:
  - HTML or image -> Ovis webpage profile.
  - PDF -> Paddle document profile.

Example:

```ts
fetch_content({
  url: "https://example.com/visual-dashboard",
  extractionMode: "visual",
});
```

An explicit `visual` request should return an actionable local configuration or service error. It should not silently switch to an unrelated hosted provider.

### Automatic HTML routing

Proposed order when the Ovis profile is configured:

```text
HTTP / Readability / RSC
        |
        v
Jina Reader
        |
        v
Local rendered-page OCR (OvisOCR2)
        |
        v
Parallel
        |
        v
Gemini fallbacks
```

This order preserves cheap semantic extraction, then uses the user's local service before consuming remote provider capacity.

Automatic visual fallback should run only after a recoverable failure or clearly inadequate result. It should not run merely because Markdown formatting is imperfect.

### Automatic PDF routing

```text
Existing document conversion
        |
        +-- useful text --> return existing result
        |
        +-- empty/sparse result
                |
                +-- Paddle profile configured --> send original PDF to Paddle full pipeline
                |
                +-- not configured/unavailable --> preserve existing behavior with diagnostic context
```

The first implementation should send the original sparse PDF to the configured Paddle service. Page rasterization and native/OCR page merging can be added later if real mixed-PDF examples justify the complexity.

### Direct image URLs

When `Content-Type` is a supported image:

- `auto` or `visual`: route to the configured Ovis profile.
- `text`: retain unsupported-content behavior.
- No Ovis profile: retain current behavior in `auto`, or return a configuration diagnostic in `visual`.

The image branch must occur before the current unsupported-content rejection.

## Proposed configuration

Add an optional `ocr` object to the existing Web Access configuration file:

```json
{
  "ocr": {
    "enabled": true,
    "webpage": {
      "protocol": "openai-compatible",
      "baseUrl": "http://127.0.0.1:8082/v1",
      "model": "ovisocr2",
      "timeoutSeconds": 90,
      "maxOutputTokens": 16384
    },
    "document": {
      "protocol": "paddle-service",
      "baseUrl": "http://127.0.0.1:8083",
      "timeoutSeconds": 180
    },
    "browser": {
      "executablePath": "/usr/bin/chromium",
      "viewportWidth": 1440,
      "tileHeight": 1800,
      "tileOverlap": 160,
      "maxTiles": 12,
      "settleMs": 1000
    },
    "pdf": {
      "minUsefulCharacters": 500,
      "maxPages": 50
    }
  }
}
```

Suggested settings:

```ts
interface OcrWebpageSettings {
  readonly protocol: "openai-compatible";
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutSeconds: number;
  readonly maxOutputTokens: number;
}

interface OcrDocumentSettings {
  readonly protocol: "paddle-service";
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutSeconds: number;
}

interface OcrBrowserSettings {
  readonly executablePath?: string;
  readonly viewportWidth: number;
  readonly tileHeight: number;
  readonly tileOverlap: number;
  readonly maxTiles: number;
  readonly settleMs: number;
}

interface OcrPdfSettings {
  readonly minUsefulCharacters: number;
  readonly maxPages: number;
}

interface OcrSettings {
  readonly enabled: boolean;
  readonly webpage?: OcrWebpageSettings;
  readonly document?: OcrDocumentSettings;
  readonly browser: OcrBrowserSettings;
  readonly pdf: OcrPdfSettings;
}
```

Validation requirements:

- `ocr.enabled` defaults to `false`.
- At least one provider profile must be present when enabled.
- Either profile may be configured independently.
- Endpoint URLs must be absolute `http:` or `https:` URLs.
- Endpoint URLs must not contain embedded credentials.
- Browser and PDF limits must be bounded.
- `tileOverlap` must be smaller than `tileHeight`.
- Unknown keys should use the existing warning behavior.
- Service availability should be checked lazily, not at extension startup.
- An offline local service must not prevent Pi from starting.

## Provider contracts

Keep the shared contract small while preserving provider-specific behavior in adapters:

```ts
type OcrMethod = "ocr-webpage" | "ocr-document";

interface OcrInput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sourceUrl: string;
  readonly signal?: AbortSignal;
}

interface OcrResult {
  readonly markdown: string;
  readonly method: OcrMethod;
  readonly provider: "ovisocr2" | "paddleocr-vl";
  readonly model?: string;
  readonly title?: string;
  readonly warnings: readonly string[];
  readonly unitsProcessed?: number;
  readonly truncated?: boolean;
}

interface OcrProvider {
  recognize(input: OcrInput): Promise<OcrResult>;
}
```

The router chooses the provider. Adapters should not inspect unrelated extraction state.

## OvisOCR2 webpage adapter

### Serving expectation

The extension expects a user-managed OpenAI-compatible multimodal endpoint. A documented example can use Bartowski's Q8 GGUF with a current llama.cpp build:

```bash
llama-server \
  -hf bartowski/ATH-MaaS_OvisOCR2-GGUF:Q8_0 \
  --host 127.0.0.1 \
  --port 8082 \
  -ngl 999 \
  --ctx-size 16384 \
  --parallel 1 \
  --temp 0
```

This is an example only. The extension should not assume llama.cpp or a particular quantization.

### Request contract

- OpenAI-compatible `/chat/completions` multimodal request.
- One screenshot tile per request.
- Temperature `0`.
- Configured output token limit, default `16384`.
- Sequential tile processing initially.
- Data URL or other request format supported by the adapter contract.

Default instruction:

```text
Extract all readable content from the image in natural human reading order and output it as a single Markdown document. Preserve original text without translation, correction, summary, or paraphrase. Format formulas as LaTeX and tables as HTML. Mark unreadable spans explicitly rather than guessing.
```

### Output normalization

Normalize conservatively:

1. Preserve Markdown, HTML tables, and LaTeX.
2. Preserve or explicitly mark unresolved visual-region tags.
3. Detect and trim only strongly repetitive terminal sequences.
4. Never silently repair numbers, URLs, dates, or identifiers.
5. Add warnings whenever output is truncated or normalized.

## Webpage renderer

Use `playwright-core` with a user-installed Chrome or Chromium executable. Do not depend on the full Playwright package or download a browser during installation.

### Browser isolation

Each extraction should use a fresh ephemeral context:

- No user profile.
- No cookies by default.
- No saved credentials.
- No camera, microphone, geolocation, notifications, or downloads.
- JavaScript enabled because the fallback targets rendered applications.
- Context and browser closed in `finally`, including timeout and abort paths.

The existing browser-cookie access used by Gemini Web must not be reused implicitly. Authenticated visual extraction would require a separate explicit design and security review.

### Navigation and resource controls

- Revalidate the main URL through existing SSRF policy.
- Intercept subresources and block disallowed private/reserved destinations.
- Restrict navigation to HTTP(S).
- Reject downloads and new windows.
- Bound navigation, settling, screenshot, and OCR time.
- Preserve caller abort semantics.
- Do not click, submit, expand, or interact beyond vertical scrolling required for capture.

### Tiling

Do not shrink an arbitrarily tall webpage into one model input.

Initial defaults:

```text
Viewport width:  1440 CSS px
Tile height:     1800 CSS px
Overlap:          160 CSS px
Maximum tiles:     12
Device scale:       1
```

Process:

1. Navigate and wait for `domcontentloaded`.
2. Wait the bounded settle period.
3. Determine document height.
4. Scroll through deterministic vertical tile positions.
5. Allow a short lazy-load settle after each scroll.
6. Capture viewport-sized screenshots.
7. Send tiles to Ovis in document order.
8. Merge Markdown using normalized suffix/prefix overlap.
9. Report truncation when `maxTiles` is reached.

Fixed and sticky overlays may be hidden after the first tile when they would otherwise repeat, but this should be implemented conservatively and tested.

### Preserve web-native information

OCR cannot infer link targets. Before capture, collect visible anchors from the DOM:

```ts
interface VisibleLink {
  readonly text: string;
  readonly href: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
```

Append a deduplicated `Visible links` section after OCR output. Also preserve title, canonical URL, final URL, language, and meta description when available.

## PaddleOCR-VL document adapter

### Require the full pipeline endpoint

The `document` profile must target PaddleOCR-VL's full document pipeline service, not merely an OpenAI-compatible endpoint serving the raw GGUF.

Conceptually:

```text
pi-web-access
    |
    v
PaddleOCR-VL full service
    |
    +-- layout analysis
    +-- region recognition, optionally through local llama.cpp
    +-- Markdown / JSON assembly
```

The user may configure the Paddle service to use the official PaddleOCR-VL-1.6 GGUF internally, but that topology is outside the extension.

### Request behavior

- Send the original PDF when existing conversion is empty or sparse.
- Preserve configured timeout and page limits.
- Prefer Markdown output.
- Parse provider JSON through a strict adapter.
- Preserve page boundaries when returned.
- Surface provider warnings and truncation.
- Propagate `AbortSignal`.
- Keep exact endpoint paths and response fields inside `ocr-paddle.ts` so upstream contract changes remain isolated.

## PDF quality gate

Start with a conservative document-level text gate:

```ts
function hasUsefulNativeDocumentText(markdown: string, threshold: number): boolean {
  const normalized = markdown
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length >= threshold;
}
```

This is intended to detect empty image-only PDFs, not perfectly classify mixed PDFs. Page-level analysis should be added only after collecting failing examples.

## Routing matrix

| Input | Mode | Webpage profile | Document profile | Result |
| --- | --- | ---: | ---: | --- |
| HTML | `auto` | No | Any | Existing chain only |
| HTML after failed text extraction | `auto` | Yes | Any | Render and use Ovis; continue existing hosted fallbacks after recoverable local failure |
| HTML | `visual` | Yes | Any | Render and use Ovis directly |
| HTML | `visual` | No | Any | Configuration diagnostic |
| Image | `auto` or `visual` | Yes | Any | Ovis |
| Image | `text` | Any | Any | Existing unsupported-content behavior |
| Text PDF | `auto` | Any | Any | Existing document result |
| Sparse/scanned PDF | `auto` | Any | Yes | Paddle full pipeline |
| Sparse/scanned PDF | `auto` | Any | No | Existing behavior with current error path |
| PDF | `visual` | Any | Yes | Paddle full pipeline directly |
| PDF | `visual` | Any | No | Configuration diagnostic |
| Any | `text` | Any | Any | Never invoke OCR |

## Proposed files

```text
ocr-types.ts                 Shared settings, input, result, and provenance types
ocr-router.ts                Task selection and profile availability
ocr-openai-compatible.ts     Ovis request/response adapter
ocr-paddle.ts                Paddle full-service adapter
browser-renderer.ts          Isolated Chromium rendering, tiling, and link collection
ocr-normalize.ts             Conservative Ovis cleanup and tile merging
```

Expected existing-file changes:

```text
configuration.ts             Defaults, parsing, validation, immutable settings
extract.ts                   Image path, HTML fallback insertion, PDF quality gate
fetch-params.ts              Normalize `extractionMode`
index.ts                     Add `extractionMode` to the tool schema and pass settings
package.json                 Add `playwright-core`
README.md                    Configuration and local serving examples
```

Avoid placing provider-specific HTTP or browser-rendering logic directly in `extract.ts`.

## Failure behavior

### Automatic mode

- Ovis endpoint unavailable: record a diagnostic and continue to Parallel/Gemini.
- Browser unavailable: record a diagnostic and continue to existing hosted fallbacks.
- Paddle unavailable:
  - If some useful native PDF text exists, return it with a warning.
  - Otherwise preserve existing extraction failure and add local OCR configuration context.
- Timeout or abort: stop promptly and preserve abort behavior.
- Malformed provider response: treat as recoverable provider failure, not extracted content.

### Explicit visual mode

Return a clear error identifying the missing or failed component:

- OCR disabled.
- Webpage or document profile not configured.
- Browser executable unavailable.
- Local endpoint unreachable.
- Input exceeds configured page, tile, byte, or time limits.

Do not silently invoke hosted providers for an explicit local visual request.

## Provenance

Extend results with optional provenance:

```ts
interface ExtractionProvenance {
  readonly method:
    | "native"
    | "reader"
    | "ocr-webpage"
    | "ocr-document";
  readonly provider?: "ovisocr2" | "paddleocr-vl";
  readonly model?: string;
  readonly unitsProcessed?: number;
  readonly truncated?: boolean;
  readonly warnings?: readonly string[];
}
```

Output presented to the agent should disclose:

- That OCR was used.
- Which route produced the result.
- Whether only part of the page or document was processed.
- Whether repetitive output was trimmed.
- Whether unresolved visual regions remain.

## Security considerations

1. OCR endpoints come only from trusted configuration, never page content.
2. Validate endpoint syntax and pin requests to the configured origin.
3. Disable or strictly validate redirects from OCR endpoints.
4. Apply SSRF policy to main browser navigation and subresources.
5. Use ephemeral browser contexts without user profiles or cookies.
6. Disable downloads, popups, and unnecessary permissions.
7. Limit response bytes, PDF pages, viewport dimensions, tiles, output tokens, and total time.
8. Treat OCR output as untrusted web content.
9. Never execute scripts, HTML, links, or instructions emitted by a model.
10. Avoid logging image bytes, API keys, or full sensitive documents.
11. Do not auto-download models or browser binaries.
12. Keep local-service failures recoverable in automatic mode.

## Testing plan

All automated tests should use mocked HTTP and browser fixtures. CI must not require a GPU, Chromium installation, or live OCR service.

### Configuration

- OCR is disabled by default.
- Profiles can be configured independently.
- Unknown keys follow current warning behavior.
- Invalid endpoint protocols and embedded credentials fail validation.
- Numeric bounds and overlap constraints are enforced.
- Settings remain immutable.
- Offline services do not fail extension startup.

### Router and extraction chain

- Cover the full routing matrix.
- Native PDF text wins in `auto`.
- `text` never invokes OCR.
- `visual` produces actionable missing-profile errors.
- Recoverable Ovis failures continue to Parallel/Gemini.
- Direct images route before unsupported-content rejection.
- Abort signals stop browser and provider work.

### Ovis adapter

- Correct OpenAI-compatible multimodal request.
- Deterministic request settings.
- Data URL and MIME handling.
- Markdown response parsing.
- Repetitive-tail detection does not trim legitimate repeated table rows.
- Token-limit finish reasons produce truncation warnings.

### Browser renderer

- Uses an ephemeral context.
- Does not load a user profile or cookies.
- Tiling positions and overlap are deterministic.
- Maximum-tile truncation is reported.
- Visible links are normalized and deduplicated.
- Private/reserved subresources are blocked.
- Browser closes on success, error, timeout, and abort.

### Paddle adapter

- Sends PDF bytes using the official service contract.
- Parses Markdown and page metadata fixtures.
- Handles provider warnings and page limits.
- Rejects malformed or oversized responses.
- Propagates timeout and abort.
- Does not receive a text-rich PDF in `auto`.

### Integration

- Existing tests pass with no OCR configuration.
- Direct image URL succeeds with Ovis configured.
- A JavaScript-rendered fixture falls back to Ovis after text extraction fails.
- A normal text fixture never launches Chromium.
- An image-only PDF fixture routes to Paddle.
- A normal text PDF remains on `convertDocument`.
- Local endpoint failure preserves existing fallback behavior.

## Implementation phases

### Phase 1: Configuration, contracts, and direct images

- Add settings and validation.
- Add shared OCR types and router.
- Add Ovis OpenAI-compatible adapter.
- Route direct image URLs.
- Add mocked tests.

### Phase 2: Rendered webpage fallback

- Add `playwright-core`.
- Implement isolated Chromium rendering and tiling.
- Insert local webpage OCR after Jina and before Parallel.
- Add `extractionMode`.
- Preserve visible links and metadata.
- Add renderer and integration tests.

### Phase 3: Paddle document route

- Add the PDF quality gate.
- Add Paddle full-service adapter.
- Route sparse/scanned PDFs.
- Preserve normal PDF behavior.
- Add PDF fixtures and integration tests.

### Phase 4: Evaluation-driven refinements

Only after collecting real failures:

- Tune routing thresholds.
- Consider page-level native/OCR merging.
- Add optional tile concurrency.
- Add an explicit document-image hint if needed.
- Compare Ovis Q8/BF16 and Paddle deployment variants.
- Consider extracting visual-region crops rather than retaining placeholders.

## Acceptance criteria

- [ ] OCR is disabled by default and all existing tests pass.
- [ ] Either profile can be configured independently.
- [ ] A configured Ovis endpoint extracts a direct image URL.
- [ ] Failed HTML extraction can render in isolated Chromium and route to Ovis.
- [ ] Long pages are tiled without silently discarding the tail.
- [ ] Visible link destinations are preserved separately from OCR text.
- [ ] Normal text PDFs continue to use existing conversion.
- [ ] Scanned PDFs route to Paddle's full pipeline.
- [ ] Paddle configuration cannot be confused with its raw VLM endpoint.
- [ ] Automatic local failures continue existing recoverable fallbacks.
- [ ] Explicit visual failures return actionable diagnostics.
- [ ] Abort, timeout, SSRF, and resource limits are covered by tests.
- [ ] Output discloses OCR provenance and truncation warnings.
- [ ] CI requires neither a live browser nor a live OCR service.

## Open implementation questions

1. Which exact fields from the current Paddle service response should become the stable internal adapter contract?
2. Should Ovis visual-region tags be retained verbatim or replaced with explicit placeholders initially?
3. What signal should supplement `minUsefulCharacters` after mixed PDFs are collected?
4. Should local webpage OCR always run before Parallel, or eventually become user-configurable?
5. Should visible links be appended globally or associated with the tile where they appeared?
6. Which Chromium executable discovery paths should be supported beyond explicit configuration?

These questions do not block the proposed architecture or phased implementation.