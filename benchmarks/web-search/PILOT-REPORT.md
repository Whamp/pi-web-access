# Web search benchmark pilot

## Bottom line

After excluding the three GitHub-fetch questions, the browser skill produced the preferred final answer on **3/7** questions; the incumbent OpenAI path won **1/7**, with **3 ties**. Both systems completed every retained question.

That quality gain was not token-efficient in the requesting chat. The browser path used **759,604** requesting-agent tokens versus **192,323** for the incumbent (**+295.0%**). Even after adding the incumbent's captured hidden OpenAI search usage, the browser path used **+127.3%** more known model tokens: **759,604** versus **334,248**.

**Recommendation:** keep the incumbent as the default. Trial the browser backend as a fallback or borrow its source-selection approach, but do not promote the skill as-is on token-efficiency grounds.

## Controlled setup

- 10 fixed web-research questions were collected; 7 are analyzed after excluding q01, q05, q09.
- Same requesting model: `openai-codex/gpt-5.6-luna:xhigh`.
- Incumbent: this repository's registered tools. Every recorded search call was validated as `provider: "openai"` and `workflow: "none"`.
- Browser: ogulcancelik/agent-skills at `8b28169438c4edbd12a3d03a21f818a87c8f2901`, with the benchmark forcing search and retrieval through its CLI.
- Fresh in-memory Pi session for every answer; path order alternated by question.
- All retained browser runs were warm; the excluded q01 run contained the recorded cold start.
- Two anonymous judges per answer pair (OpenAI + GLM); adjudication resolved 1 disagreement.

## System measurements

| Metric | Incumbent | Browser | Browser vs incumbent |
| --- | ---: | ---: | ---: |
| Completed answers | 7/7 | 7/7 | — |
| Requesting-agent tokens | 192,323 | 759,604 | +295.0% |
| Hidden search-provider tokens | 141,925 | 0 | — |
| Known model tokens | 334,248 | 759,604 | +127.3% |
| Requesting-agent cost | $0.160 | $0.357 | +122.8% |
| Median answer time | 43.2s | 49.9s | +15.5% |
| Total answer time | 403.2s | 631.4s | +56.6% |
| Agent turns | 29 | 73 | +151.7% |
| Tool calls | 30 | 68 | +126.7% |
| Tool-result characters | 267,843 | 495,967 | +85.2% |

The incumbent's hidden search-provider token count was captured from the OpenAI Responses stream. Its monetary cost is not exposed when using the Codex subscription, so the cost row covers only the shared requesting model. Browser CPU and memory costs were not priced.

## Answer quality

| Result | Count |
| --- | ---: |
| Browser preferred | 3 |
| Incumbent preferred | 1 |
| Tie | 3 |
| Unresolved | 0 |

Where the judges separated the retained pairs, browser answers were usually more complete and better sourced. The judging itself used 112,085 tokens and about $0.347. That figure covers judging the original ten pairs; judge usage is excluded from both systems' measurements.

## Per-question results

| Question | Winner | Incumbent agent / provider tokens | Browser agent tokens | Incumbent time | Browser time |
| --- | --- | ---: | ---: | ---: | ---: |
| q02 — release lookup | tie | 16,963 / 7,263 | 57,743 | 30.7s | 49.9s |
| q03 — API documentation | browser | 65,321 / 58,708 | 84,664 | 137.6s | 217.7s |
| q04 — language release | tie | 9,823 / 7,260 | 16,993 | 23.1s | 30.3s |
| q06 — site-constrained documentation | incumbent | 53,507 / 25,069 | 318,355 | 95.1s | 175.4s |
| q07 — language documentation | browser | 25,969 / 14,618 | 249,921 | 43.2s | 95.9s |
| q08 — API synthesis | browser | 13,310 / 21,908 | 19,269 | 54.3s | 37.2s |
| q10 — database documentation | tie | 7,430 / 7,099 | 12,659 | 19.3s | 25.1s |

## Important limits

- This is a seven-question recalculation of a ten-question pilot, not a statistically stable benchmark.
- Questions emphasize technical documentation and release research; other search workloads may behave differently.
- Each pair ran once. Search results, model behavior, and network conditions can vary.
- The incumbent was specifically OpenAI, not the full automatic provider chain.
- The candidate repository has no lockfile. This benchmark supplied a committed lockfile and used a clean `npm ci` before collection.
- The original browser prompt incorrectly prohibited `curl`, `wget`, and other retrieval routes even though the skill recommends `gh` for GitHub and `curl` for simple URLs. Excluding the three direct-GitHub questions removes the clearest distortion, but the remaining comparison is still provisional rather than a faithful as-published test.
- 2 tool calls failed and recovered during the pilot (q04 browser, q07 browser). Their retries remain in the measured time and token totals.

## Evidence

- Compact machine-readable results and redacted tool audit: [`pilot-results.json`](./pilot-results.json)
- Fixed questions: [`questions.json`](./questions.json)
- Runner: [`run.mjs`](./run.mjs)
- Judge workflow: [`judge-workflow.js`](./judge-workflow.js)
- Full raw trace remains locally under `benchmarks/web-search/runs/` and is intentionally ignored by Git.
