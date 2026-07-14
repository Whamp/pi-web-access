# Web Access

Web Access finds information on the web and retrieves source content for Pi sessions.

## Language

**Web search**:
A request for an answer and sources from the web. One search provider executes each attempt.

**Search provider**:
An external search system that answers a web search and returns sources.

**Provider eligibility**:
Whether a search provider has the credentials or local access required to attempt a search. Eligibility does not guarantee that the search will succeed.
_Avoid_: Provider availability

**Explicit provider selection**:
A search that names one search provider, either in the request or as the saved default. The search uses only that provider and fails if the provider is ineligible or the search fails.

**Automatic provider selection**:
A search that delegates provider choice by selecting `auto`, either in the request or as the saved default. It tries eligible providers in preference order after provider-specific failures; caller cancellation stops the search.

**Stored result reference**:
An opaque identifier for one stored Web search or fetched source content record. Pass either kind to `get_search_content` as `resultId`.
_Avoid_: Stored search ID, response ID

**Search result reference**:
A Stored result reference for a Web search record. Producers expose it as `searchResultId`.
_Avoid_: `searchId`

**Content result reference**:
A Stored result reference for a fetched source content record. Producers expose it as `contentResultId`.
_Avoid_: Fetch result reference, `fetchId`, `responseId`
