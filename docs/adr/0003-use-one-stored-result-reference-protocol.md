---
status: accepted
---

# Use one Stored result reference protocol

Stored Web search results and stored source content remain separate record types, but agents retrieve either through one `resultId` parameter. Producers expose semantic `searchResultId` and `contentResultId` fields, and the stored-result module owns identifier generation, record creation, session publication and restoration, lookup, validation, and retrieval guidance. This decision came from an earlier `/improve-codebase-architecture` plan and was implemented through issue [#9](https://github.com/Whamp/pi-web-access/issues/9) and PR [#15](https://github.com/Whamp/pi-web-access/pull/15).

## Why

The prior `searchId`, `fetchId`, and `responseId` names forced agents to guess which identifier the retrieval tool accepted. Some identifiers appeared only in result details that the model could not see, curated summaries could omit them, and single-item records unnecessarily required an index.

The accepted protocol makes continuation explicit:

- `web_search` exposes `searchResultId` for stored Web search results.
- `web_search` and `fetch_content` expose `contentResultId` for stored source content.
- `get_search_content` accepts either kind as `resultId` and dispatches by the stored record type.
- A single-item record needs no selector; a multi-item record lists valid choices when no selector is supplied.
- Model-visible output includes the shortest exact retrieval call only when saved information was omitted.
- Publication succeeds before a record enters the runtime cache, so stale sessions cannot leave an in-memory-only result.
- Content result references returned by `web_search` are immediately usable because Agent Web search remains active through its bounded content phase.

PR #15 also corrected a stale implementation plan that had carried the removed background-fetch lifecycle forward. The integrated design has no pending content reference, delayed completion notification, or background-only result state.

## Consequences

Search and content records stay separate because they contain different data and support different selectors. A future architecture review must not propose combining them merely because they share `resultId` retrieval.

Likewise, “centralize Stored result references” is not a new architecture opportunity: PR #15 already deepened that module for publication, restoration, validation, retrieval, and runtime isolation. Further work must identify a concrete responsibility that still leaks across the existing seam, preserve immediate retrieval, and prove behavior through the registered `web_search`, `fetch_content`, and `get_search_content` tools.
