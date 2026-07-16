---
status: accepted
---

# Centralize Search provider policy without absorbing its projections

Search provider policy is centralized in `web-search.ts`, its contracts live in `search-provider.ts`, and each external provider keeps its own adapter. This shape makes Explicit provider selection strict, keeps Automatic provider selection in one fixed order, and gives Provider eligibility one shared execution path without coupling external integrations to one another. This decision came from an earlier `/improve-codebase-architecture` plan and was implemented in commit [`b8ed065`](https://github.com/Whamp/pi-web-access/commit/b8ed065ff488ee064e70e7ac463ce8149ff107bb).

## Why

Before that change, provider eligibility and fallback decisions were spread through `index.ts` and provider-specific modules. The refactor introduced `search-provider.ts`, `web-search.ts`, and fake-adapter tests so callers would share the same rules:

- Explicit provider selection attempts only the named eligible provider. It does not silently fall back.
- Automatic provider selection tries eligible providers in a fixed preference order and stops on caller cancellation.
- Provider-specific eligibility and search behavior stay in provider adapters.
- Provider policy is tested through `createWebSearch`, not through provider credentials or UI behavior.

PR [#8](https://github.com/Whamp/pi-web-access/pull/8) later treated Provider eligibility, Explicit provider selection, Automatic provider selection, preference order, and fallback behavior as invariants while changing the agent Web search lifecycle.

## Consequences

The closed provider set still appears at several distinct seams: a TypeScript union, a typed adapter collection, runtime input validation, and Search Curator rendering. These are projections of the provider set, not separate owners of provider policy. Their repetition alone is not evidence that the policy remains scattered.

A future architecture review must not propose a broad “Search provider catalog” that pulls UI rendering, transport validation, adapter behavior, and selection policy into one module. A narrow shared parser or validator may be worthwhile if concrete drift appears, but it must preserve the current ownership split and the strict-versus-automatic selection rules.
