---
status: accepted
---

# Separate Agent Web search from the Search Curator

Agent Web search is terminal and bounded: it never opens or waits for the Search Curator, starts no work that can outlive the tool call, and publishes no delayed completion turn. The Search Curator remains a deliberate user workflow started through `/websearch` and may use its own command lifecycle. This decision came from an earlier `/improve-codebase-architecture` plan and was implemented through issue [#1](https://github.com/Whamp/pi-web-access/issues/1) and PR [#8](https://github.com/Whamp/pi-web-access/pull/8).

## Why

The prior behavior depended on hidden UI state and provider response shape. Previously, an agent Web search could open a browser and wait for human action, or return before detached source retrieval finished. That made completion unpredictable and allowed cancellation, session replacement, or shutdown to race delayed work and publication.

The accepted design gives an agent Web search one completion point:

- A search without requested source content finishes after its provider attempts.
- A search requesting source content owns a bounded 60-second content phase and returns completed content plus per-source failures or timeouts.
- Provider-inline and retrieved content form one ordered, de-duplicated continuation.
- Caller cancellation and session replacement stop active work and prevent later publication.
- Automatic summary generation completes before the tool returns.
- The same request has the same interaction behavior in UI and headless sessions.

The change deliberately preserved explicit human review. Issue #1 says user-initiated command lifecycles are not redefined by terminal agent execution, and lists redesigning the Search Curator and `curator-server.ts` as out of scope.

## Consequences

There are two intentional entry paths, not two interchangeable implementations:

1. Agent Web search returns one terminal tool result.
2. `/websearch` starts the Search Curator and can send an approved result as a follow-up.

Commit [`e4af447`](https://github.com/Whamp/pi-web-access/commit/e4af447114e738307ac8c345f0ceac2d0af9bb2c) removed the only `pendingCurates.set(...)` call when it removed implicit agent curation. Any surviving `PendingCurate`, `pendingCurates`, `openCuratorBrowser()`, “Review search results” shortcut, or source-shape test for that path is unreachable residue, not a second live curator design. Delete such residue when encountered.

That cleanup does not justify folding the active `/websearch` lifecycle into `curator-server.ts`. The server still owns local HTTP, SSE, request validation, and watchdog behavior; the command owns Pi messaging, browser opening, Web search, summary generation, configuration, and Stored result reference publication. A future redesign of that seam requires new evidence and behavioral coverage beyond the cleanup residue.
