# Web Access

Web Access finds information on the web and retrieves source content for Pi sessions.

## Language

**Web search**:
A request for an answer and sources from the web. One search provider executes each attempt.

**Agent Web search**:
A Web search performed for an agent turn. It has one terminal completion point and never opens the Search Curator.

**Search Curator**:
A user-initiated browser workflow for selecting Web search results and approving a summary. It is not part of Agent Web search.

**Web Access configuration**:
User-controlled persistent settings for Web Access, interpreted with shared defaults. Credentials supplied outside those settings and provider eligibility are resolved separately.

**Search provider**:
An external search system that answers a web search and returns sources.

**Provider eligibility**:
Whether a search provider has the credentials, model selection, or local access required to attempt a search. Eligibility does not guarantee that the search will succeed.
_Avoid_: Provider availability

**OpenAI search model**:
The user-configurable OpenAI model and optional reasoning level used internally by the OpenAI Search provider. It is independent of the model whose agent turn calls Web search.
_Avoid_: Active model, synthesis model

**Provider warning**:
An actionable, non-terminal diagnostic from Automatic provider selection. It is returned to the calling agent while Web search continues with another Search provider.
_Avoid_: Provider error

**Explicit provider selection**:
A search that names one search provider, either in the request or as the saved default. The search uses only that provider and fails if the provider is ineligible or the search fails.

**Automatic provider selection**:
A search that delegates provider choice by selecting `auto`, either in the request or as the saved default. It tries eligible providers in preference order after provider-specific failures; caller cancellation stops the search.

**Stored result reference**:
An opaque identifier for one stored Web search or fetched source content record. Pass either kind to `get_search_content` as `resultId`.

**Content result reference**:
A Stored result reference for a fetched source content record. Producers expose it as `contentResultId`.

**Client-rendered shell**:
A retrieved page representation whose structural placeholders are present but whose substantive content is populated only during client-side rendering. Recognizing a Client-rendered shell is a high-confidence structural classification, not a judgment that arbitrary fetched content is semantically complete. It is a failed retrieval candidate, not successful source content.
_Avoid_: Incomplete page
