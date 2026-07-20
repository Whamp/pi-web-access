# Web search benchmark pilot

## Bottom line

The browser skill produced the preferred final answer on **5/10** questions; the incumbent OpenAI path won **1/10**, with **4 ties**. Both systems completed every question.

That quality gain was not token-efficient in the requesting chat. The browser path used **2,031,669** requesting-agent tokens versus **445,968** for the incumbent (**+355.6%**). Even after adding the incumbent's captured hidden OpenAI search usage, the browser path used **+184.4%** more known model tokens: **2,031,669** versus **714,441**.

**Recommendation:** keep the incumbent as the default. Trial the browser backend as a fallback or borrow its source-selection approach, but do not promote the skill as-is on token-efficiency grounds.

## Controlled setup

- 10 fixed web-research questions; one run per system and question.
- Same requesting model: `openai-codex/gpt-5.6-luna:xhigh`.
- Incumbent: this repository's registered tools. Every recorded search call was validated as `provider: "openai"` and `workflow: "none"`.
- Browser: ogulcancelik/agent-skills at `8b28169438c4edbd12a3d03a21f818a87c8f2901`, used through its documented skill and CLI.
- Fresh in-memory Pi session for every answer; path order alternated by question.
- 1 recorded browser cold start; the remaining browser runs were warm.
- Two anonymous judges per answer pair (OpenAI + GLM); adjudication resolved 1 disagreement.

## System measurements

| Metric | Incumbent | Browser | Browser vs incumbent |
| --- | ---: | ---: | ---: |
| Completed answers | 10/10 | 10/10 | — |
| Requesting-agent tokens | 445,968 | 2,031,669 | +355.6% |
| Hidden search-provider tokens | 268,473 | 0 | — |
| Known model tokens | 714,441 | 2,031,669 | +184.4% |
| Requesting-agent cost | $0.323 | $0.733 | +126.9% |
| Median answer time | 71.2s | 87.3s | +22.6% |
| Total answer time | 734.7s | 1056.9s | +43.9% |
| Agent turns | 47 | 130 | +176.6% |
| Tool calls | 57 | 131 | +129.8% |
| Tool-result characters | 617,879 | 909,968 | +47.3% |

The incumbent's hidden search-provider token count was captured from the OpenAI Responses stream. Its monetary cost is not exposed when using the Codex subscription, so the cost row covers only the shared requesting model. Browser CPU and memory costs were not priced.

## Answer quality

| Result | Count |
| --- | ---: |
| Browser preferred | 5 |
| Incumbent preferred | 1 |
| Tie | 4 |
| Unresolved | 0 |

The required-source gate corrected q09: both systems answered from a different, similarly named repository and therefore failed that question. Where the judges separated the remaining pairs, browser answers were usually more complete and better sourced. The judging itself used 112,085 tokens and about $0.347. Judge usage is excluded from both systems' measurements.

## Per-question results

| Question | Winner | Incumbent agent / provider tokens | Browser agent tokens | Incumbent time | Browser time |
| --- | --- | ---: | ---: | ---: | ---: |
| q01 — developer documentation | browser | 109,441 / 32,367 | 397,471 | 97.9s | 119.5s |
| q02 — release lookup | tie | 16,963 / 7,263 | 57,743 | 30.7s | 49.9s |
| q03 — API documentation | browser | 65,321 / 58,708 | 84,664 | 137.6s | 217.7s |
| q04 — language release | tie | 9,823 / 7,260 | 16,993 | 23.1s | 30.3s |
| q05 — recent software release | browser | 93,224 / 64,482 | 165,938 | 145.6s | 78.6s |
| q06 — site-constrained documentation | incumbent | 53,507 / 25,069 | 318,355 | 95.1s | 175.4s |
| q07 — language documentation | browser | 25,969 / 14,618 | 249,921 | 43.2s | 95.9s |
| q08 — API synthesis | browser | 13,310 / 21,908 | 19,269 | 54.3s | 37.2s |
| q09 — tool evaluation | tie | 50,980 / 29,699 | 708,656 | 88.0s | 227.4s |
| q10 — database documentation | tie | 7,430 / 7,099 | 12,659 | 19.3s | 25.1s |

## Important limits

- This is a 10-question pilot, not a statistically stable benchmark.
- Questions emphasize technical documentation and release research; other search workloads may behave differently.
- Each pair ran once. Search results, model behavior, and network conditions can vary.
- The incumbent was specifically OpenAI, not the full automatic provider chain.
- The candidate repository has no lockfile. This benchmark supplied a committed lockfile and used a clean `npm ci` before collection.
- The browser path was tested as the published skill. A purpose-built internal adapter could use fewer turns and avoid printing large pages into context.
- 6 tool calls failed and recovered during the pilot (q04 browser, q05 browser, q07 browser, q09 browser, q09 browser, q09 browser). Their retries remain in the measured time and token totals.

## Evidence

- Compact machine-readable results and redacted tool audit: [`pilot-results.json`](./pilot-results.json)
- Fixed questions: [`questions.json`](./questions.json)
- Runner: [`run.mjs`](./run.mjs)
- Judge workflow: [`judge-workflow.js`](./judge-workflow.js)
- Full raw trace remains locally under `benchmarks/web-search/runs/` and is intentionally ignored by Git.
