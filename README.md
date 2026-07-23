<p>
  <img src="banner.png" alt="Pi Web Access" width="1100">
</p>

# Pi Web Access

Web search, source retrieval, document conversion, GitHub cloning, and video understanding for [Pi](https://pi.dev).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)](#limitations)

> [!NOTE]
> This repository is an independent hard fork of [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access), maintained by [Whamp](https://github.com/Whamp). It is distributed directly from GitHub and follows its own roadmap.

## Install

Pi packages run with full system access. Review the source before installing.

```bash
pi install git:github.com/Whamp/pi-web-access
```

Install it for one project instead of globally:

```bash
pi install -l git:github.com/Whamp/pi-web-access
```

Update or remove it with Pi:

```bash
pi update --extensions
pi remove git:github.com/Whamp/pi-web-access
```

If the original npm package is installed, replace it:

```bash
pi remove npm:pi-web-access
pi install git:github.com/Whamp/pi-web-access
```

This fork is not published to npm.

## What it provides

- **Web search:** OpenAI, Exa, Brave, Parallel, Tavily, Perplexity, and Gemini.
- **Source retrieval:** readable Markdown from web pages, PDFs, DOCX, PPTX, XLSX, JSON, text, and Next.js RSC responses.
- **GitHub access:** local clones for repository URLs, with API fallback for large repositories and commit URLs.
- **Video understanding:** YouTube and local video analysis through Gemini, plus timestamped frame extraction.
- **Search review:** an optional browser curator for selecting results and approving summaries.
- **Library research:** the bundled `librarian` skill combines search, cloning, Git history, and GitHub permalinks.

[Watch the demo](./pi-web-fetch-demo.mp4).

## Quick start

```typescript
web_search({ query: "TypeScript error handling" })

web_search({
  queries: ["React compiler status", "React compiler migration guide"],
  provider: "auto",
  workflow: "auto-summary",
})

fetch_content({ url: "https://docs.example.com/guide" })

fetch_content({ url: "https://github.com/owner/repository" })

fetch_content({
  url: "https://youtube.com/watch?v=abc",
  prompt: "Which libraries are demonstrated?",
})

fetch_content({
  url: "/path/to/recording.mp4",
  prompt: "What error appears on screen?",
})
```

## Search-provider behavior

`auto` tries eligible providers in this fixed order:

1. OpenAI, when the request uses the default result count and no recency filter
2. Exa
3. Brave
4. Parallel
5. Tavily
6. Perplexity
7. Gemini

An automatic search skips ineligible providers and continues after provider-specific failures. Caller cancellation stops the search.

A named provider is strict, whether it comes from the request or saved configuration. If that provider is ineligible or fails, Pi reports its error without switching providers.

Gemini API-to-Web fallback remains internal to the Gemini provider. Exa uses its direct API when configured and its MCP endpoint otherwise.

## Tools

### `web_search`

Search one query or a batch of queries. Results include an answer and source citations.

```typescript
web_search({ query: "Rust async programming" })
web_search({ queries: ["query one", "query two"] })
web_search({ query: "latest releases", recencyFilter: "week" })
web_search({ query: "package docs", domainFilter: ["github.com"] })
web_search({ query: "security advisory", provider: "brave" })
web_search({ query: "framework comparison", includeContent: true })
web_search({ query: "release notes", workflow: "none" })
web_search({ query: "release notes", workflow: "auto-summary" })
```

| Parameter | Description |
| --- | --- |
| `query` / `queries` | One query or a batch of queries |
| `numResults` | Results per query; default 5, maximum 20 |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Include domains; prefix a domain with `-` to exclude it |
| `provider` | `auto`, `openai`, `exa`, `brave`, `parallel`, `tavily`, `perplexity`, or `gemini` |
| `includeContent` | Fetch complete source content before the tool returns |
| `workflow` | `none` (default) or `auto-summary` |

With `includeContent: true`, `web_search` runs a bounded 60-second content phase before returning. It retains provider-supplied inline content and retrieves only missing sources, de-duplicated in first-result order. A deadline returns completed content plus a local timeout error for each unfinished source.

The result details expose saved Web search results as `searchResultId`. When full content was requested, they expose the merged content as `contentResultId`, with `contentReady` and `contentErrors` counts. Pass either reference to `get_search_content` as `resultId`; the content reference is ready when `web_search` returns, with no delayed follow-up.

### `fetch_content`

Fetch one URL, several URLs, a GitHub repository, a YouTube video, or a local video file.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["https://example.com/a", "https://example.com/b"] })
fetch_content({ url: "https://github.com/owner/repository" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "Summarize chapter two" })
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 4 })
fetch_content({ url: "/path/to/video.mp4", frames: 6 })
```

| Parameter | Description |
| --- | --- |
| `url` / `urls` | One URL or path, or several URLs |
| `prompt` | Question about a YouTube or local video |
| `timestamp` | A timestamp, timestamp range, or seconds |
| `frames` | Frames to extract; maximum 12 |
| `forceClone` | Clone a GitHub repository above the normal size limit |
| `model` | Override the Gemini video-analysis model |

### `get_search_content`

Retrieve full results stored by an earlier search or fetch. `web_search` publishes Web search records as `searchResultId`. It may also publish fetched source content as a separate `contentResultId`. `fetch_content` publishes fetched source content as `contentResultId`. Pass either value to `get_search_content` as `resultId`.

A one-item record needs no selector:

```typescript
web_search({ query: "TypeScript error handling" })
// Use the searchResultId from the result:
get_search_content({ resultId: "<searchResultId>" })

fetch_content({ url: "https://example.com/article" })
// Use the contentResultId from the result:
get_search_content({ resultId: "<contentResultId>" })
```

For a multi-item record, call the tool without a selector to list the indexed choices, then select one by value or index:

```typescript
get_search_content({ resultId: "<searchResultId>" })
get_search_content({ resultId: "<searchResultId>", queryIndex: 1 })
get_search_content({ resultId: "<searchResultId>", query: "original query" })

get_search_content({ resultId: "<contentResultId>" })
get_search_content({ resultId: "<contentResultId>", urlIndex: 1 })
get_search_content({ resultId: "<contentResultId>", url: "https://example.com/article" })
```

Large content is truncated in the immediate tool response but remains available through this tool.

## Content routing

```text
web_search(query, provider: auto)
  → OpenAI when policy permits
  → Exa → Brave → Parallel → Tavily → Perplexity → Gemini

web_search(query, provider: named)
  → exactly that provider, or its eligibility/attempt error

fetch_content(input)
  → local video: Gemini Files API → Gemini Web
  → GitHub URL: clone → GitHub API fallback
  → YouTube: Gemini Web → Gemini API → Perplexity
  → HTTP: PDF/DOCX/PPTX/XLSX conversion
        or Readability → RSC parser → Jina Reader → Gemini fallback
  → text, JSON, or Markdown: return directly
```

### GitHub repositories

Repository URLs are cloned into a session cache. Root URLs return a tree and README; `/tree/` paths return directory listings; `/blob/` paths return file contents. Repositories above 350 MB use a lightweight GitHub API view unless `forceClone` is set. Private repositories require an authenticated `gh` CLI.

### Web pages and documents

HTML passes through Readability first. The extension can then parse Next.js RSC data or retry through Jina Reader, Parallel, and Gemini. High-confidence anti-bot challenges and Client-rendered shells are treated as failed retrieval candidates so eligible fallbacks can continue; uncertain page representations remain accepted. The SSRF guard blocks private and reserved address ranges unless explicitly configured.

PDF, DOCX, PPTX, and XLSX responses are converted to Markdown directly. PDF conversion preserves useful structure such as headings, columns, and ruled tables when the source contains it. Scanned documents require a separate OCR tool.

### YouTube and local video

Pass a `prompt` for focused analysis. Frame extraction accepts `H:MM:SS`, `MM:SS`, bare seconds, or a range. Local video analysis supports common formats up to the configured size limit.

Install optional system tools for frame extraction:

```bash
brew install ffmpeg
brew install yt-dlp
```

Use the equivalent packages on Linux or Windows. `ffmpeg` extracts frames and thumbnails; YouTube frame extraction also requires `yt-dlp`.

## Search curator

Agent `web_search` calls never open the browser curator. They return raw results by default; use `auto-summary` to generate a summary before the tool returns. Run `/websearch` when you deliberately want a local browser page for selecting results and approving summaries.

Legacy saved or bridged `summary-review` values map to non-curated raw results and return a compatibility warning.

Commands:

```text
/websearch                         open the curator
/websearch query one, query two    open it with queries
/search                            browse stored results
/google-account                    show the Gemini Web account
```

If the curator cannot open a browser automatically in Docker, WSL, SSH, or headless environments, Pi prints its URL. Copy it into a browser that can reach the Pi host, using a tunnel or port forward when needed.

Press **Ctrl+Shift+W** to toggle the request activity monitor. Shortcuts are configurable.

## Configuration

Web Access resolves `web-search.json` in this order:

1. `PI_CODING_AGENT_DIR/web-search.json`
2. `XDG_CONFIG_HOME/pi/web-search.json`
3. `~/.pi/web-search.json`

Every field is optional. If the file is missing, Web Access uses the defaults shown below. Web Access loads the file once when the extension starts. Malformed JSON or an invalid known field stops extension startup and names the file and field. Unknown fields produce one key-only warning, remain preserved when Web Access saves a supported setting, and do not block startup.

```json
{
  "provider": "auto",
  "webSearch": {
    "enabled": true
  },
  "allowBrowserCookies": false,
  "searchModel": "gemini-3-flash-preview",
  "openaiSearchModel": "gpt-5.6-luna:xhigh",
  "workflow": "none",
  "curatorTimeoutSeconds": 20,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview",
    "maxSizeMB": 50
  },
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  },
  "ssrf": {
    "allowRanges": []
  }
}
```

The same file also supports optional `openaiApiKey`, `braveApiKey`, `exaApiKey`, `parallelApiKey`, `tavilyApiKey`, `perplexityApiKey`, `geminiApiKey`, `geminiBaseUrl`, `cloudflareApiKey`, `chromeProfile`, and `summaryModel` fields. The legacy `searchProvider` field remains accepted for compatibility; `provider` is the current default-provider field. All credentials and `summaryModel` are unset by default.

`openaiSearchModel` selects the model that the OpenAI search provider uses internally; it is independent of the Pi model that calls `web_search`. Use an unqualified Pi model selector such as `gpt-5.6-luna` or `gpt-5.6-luna:xhigh`. Omitting the reasoning suffix uses the model's default effort. Web Access validates the model and reasoning level against Pi's generated catalog, prefers an `openai-codex` subscription over a direct OpenAI API key, and never substitutes another model. An invalid selector makes explicit OpenAI searches fail with corrective guidance. Automatic provider selection instead returns the guidance as a provider warning and continues to the next provider.

Set `webSearch.enabled` to `false` to unregister the `web_search` tool while keeping content-fetching tools available.

Changes saved inside Web Access, such as a Search Curator provider change, take effect for work started after the save completes. A failed save leaves the previous file and runtime settings active. Manual file edits are not watched; restart Pi to load them.

Environment variables override matching configuration fields:

- `OPENAI_API_KEY`
- `BRAVE_API_KEY`
- `EXA_API_KEY`
- `PARALLEL_API_KEY`
- `TAVILY_API_KEY`
- `PERPLEXITY_API_KEY`
- `GEMINI_API_KEY`
- `GOOGLE_GEMINI_BASE_URL`
- `CLOUDFLARE_API_KEY`
- `PI_ALLOW_BROWSER_COOKIES=1`

### Browser cookies

Gemini Web cookie access is opt-in. Set `allowBrowserCookies` or `PI_ALLOW_BROWSER_COOKIES=1`. You can select a Chromium profile with `chromeProfile`. Enabling cookie access may trigger a macOS Keychain prompt; Linux uses `secret-tool` when available.

### Gemini gateways

Set `GOOGLE_GEMINI_BASE_URL` or `geminiBaseUrl` to a compatible generate-content gateway. Cloudflare AI Gateway uses `CLOUDFLARE_API_KEY` or `cloudflareApiKey`. Local video upload still uses Google’s Files API directly.

### SSRF exceptions

`ssrf.allowRanges` exempts specific CIDR ranges from the SSRF guard. This is intended for network proxies that map public domains into a synthetic reserved range. Use the narrowest possible range. The extension rejects `0.0.0.0/0` and `::/0`.

## Development

```bash
git clone https://github.com/Whamp/pi-web-access.git
cd pi-web-access
npm install
npm test
pi -e .
```

The tests use Node’s built-in test runner. Provider tests mock network requests; they do not require live provider credentials.

| File | Purpose |
| --- | --- |
| `index.ts` | Pi extension entry point, tools, commands, and widgets |
| `search-provider.ts` | Shared provider request, result, eligibility, and adapter contracts |
| `web-search.ts` | Strict and automatic provider policy |
| `gemini-search.ts` | Gemini API and Gemini Web search implementation |
| `curator-server.ts` | Curator HTTP/SSE server and state transitions |
| `extract.ts` | Content-routing and fallback orchestration |
| `storage.ts` | Session-aware search and fetch storage |
| `test/web-search.test.mjs` | Example and property tests for provider policy |
| `skills/librarian/` | Bundled open-source library research skill |

## Limitations

- Headless, SSH, Docker, and WSL sessions may require a tunnel to open the curator URL in another browser.
- YouTube private or age-restricted videos may fail on every extraction path.
- Gemini may truncate long videos.
- Document conversion does not perform OCR.
- GitHub branch names containing slashes may misresolve file paths; cloned repositories remain navigable.
- Non-code GitHub URLs, including issues and pull requests, use normal web extraction.
- Windows support depends on the installed external tools and browser-cookie environment.

## Provenance and license

This hard fork retains the original Git history and credits. Nico Bailon created the original project; Whamp maintains this independent fork.

Released under the [MIT License](LICENSE). The original copyright notice remains intact.
