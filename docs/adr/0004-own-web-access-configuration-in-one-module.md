---
status: accepted
---

# Own Web Access configuration in one module

The Web Access configuration module is the sole owner of configuration path resolution, file access, JSON parsing, strict known-field validation, shared defaults, unknown-field warnings and preservation, one current immutable runtime value, and persisted updates. A missing file uses shared defaults; invalid known fields stop startup; unknown fields warn without blocking startup. Updates use save-before-swap ordering: atomic replacement completes before the module swaps the runtime value, so active work retains its captured settings and later work receives the saved settings. Web Access does not watch the file; manual edits take effect after Pi restarts.

## Exclusions

Configuration ownership does not include credentials supplied through the environment, credential normalization, placeholder rejection, authentication, or Provider eligibility. In accordance with [ADR-0001](0001-centralize-search-provider-policy.md), it also excludes provider ordering, Explicit provider selection, Automatic provider selection, fallback, provider execution, transport validation, and UI projections. Agent Web search and Search Curator lifecycles remain separate under [ADR-0002](0002-separate-agent-web-search-from-search-curator.md), and Stored result reference behavior remains governed by [ADR-0003](0003-use-one-stored-result-reference-protocol.md).
