# Web search benchmark pilot

## Bottom line

The browser skill produced the preferred final answer on **7/10** questions; the incumbent OpenAI path won **2/10**, with **1 tie**. Both systems completed every question.

That quality gain was not token-efficient in the requesting chat. The browser path used **1,296,479** requesting-agent tokens versus **861,627** for the incumbent (**+50.5%**). After adding the incumbent's captured hidden OpenAI search usage, the known totals were much closer: **1,296,479** versus **1,219,921** (**+6.3%**).

**Recommendation:** keep the incumbent as the default. Trial the browser backend as a fallback or borrow its source-selection approach, but do not promote the skill as-is on token-efficiency grounds.

## Controlled setup

- 10 fixed web-research questions; one run per system and question.
- Same requesting model: `openai-codex/gpt-5.6-luna:xhigh`.
- Incumbent: this repository's registered tools. Every recorded search call was validated as `provider: "openai"` and `workflow: "none"`.
- Browser: ogulcancelik/agent-skills at `8b28169438c4edbd12a3d03a21f818a87c8f2901`, used through its documented skill and CLI.
- Fresh in-memory Pi session for every answer; path order alternated by question.
- 1 recorded browser cold start; the remaining browser runs were warm.
- Two anonymous judges per answer pair (OpenAI + GLM); adjudication resolved 4 disagreements.

## System measurements

| Metric | Incumbent | Browser | Browser vs incumbent |
| --- | ---: | ---: | ---: |
| Completed answers | 10/10 | 10/10 | — |
| Requesting-agent tokens | 861,627 | 1,296,479 | +50.5% |
| Hidden search-provider tokens | 358,294 | 0 | — |
| Known model tokens | 1,219,921 | 1,296,479 | +6.3% |
| Requesting-agent cost | $0.516 | $0.601 | +16.6% |
| Median answer time | 63.3s | 88.3s | +39.4% |
| Total answer time | 961.0s | 976.0s | +1.6% |
| Agent turns | 61 | 111 | +82.0% |
| Tool calls | 79 | 113 | +43.0% |
| Tool-result characters | 997,464 | 892,625 | -10.5% |

The incumbent's hidden search-provider token count was captured from the OpenAI Responses stream. Its monetary cost is not exposed when using the Codex subscription, so the cost row covers only the shared requesting model. Browser CPU and memory costs were not priced.

## Answer quality

| Result | Count |
| --- | ---: |
| Browser preferred | 7 |
| Incumbent preferred | 2 |
| Tie | 1 |
| Unresolved | 0 |

Average scores from the 20 initial judgments:

| System | Correctness | Completeness | Source quality | Directness |
| --- | ---: | ---: | ---: | ---: |
| Incumbent | 4.70 | 4.50 | 4.50 | 4.80 |
| Browser | 4.70 | 4.90 | 4.70 | 4.75 |

The quality difference was mostly completeness and source selection; both systems scored highly on correctness. The judging itself used 978,441 tokens and about $0.436. Judge usage is excluded from both systems' measurements.

## Per-question results

| Question | Winner | Incumbent agent / provider tokens | Browser agent tokens | Incumbent time | Browser time |
| --- | --- | ---: | ---: | ---: | ---: |
| q01 — developer documentation | browser | 312,488 / 53,790 | 303,548 | 146.8s | 133.4s |
| q02 — release lookup | incumbent | 17,024 / 7,524 | 57,476 | 32.9s | 35.4s |
| q03 — API documentation | browser | 130,019 / 79,319 | 101,856 | 285.0s | 199.9s |
| q04 — language release | tie | 10,302 / 14,682 | 9,327 | 31.9s | 26.2s |
| q05 — recent software release | browser | 64,956 / 43,243 | 196,203 | 74.2s | 98.6s |
| q06 — site-constrained documentation | browser | 149,348 / 56,880 | 199,828 | 153.3s | 131.7s |
| q07 — language documentation | browser | 104,118 / 14,758 | 244,911 | 50.6s | 77.9s |
| q08 — API synthesis | browser | 12,975 / 21,941 | 32,467 | 52.4s | 71.3s |
| q09 — tool evaluation | incumbent | 52,782 / 58,852 | 139,235 | 108.6s | 177.3s |
| q10 — database documentation | browser | 7,615 / 7,305 | 11,628 | 25.3s | 24.2s |

## Important limits

- This is a 10-question pilot, not a statistically stable benchmark.
- Questions emphasize technical documentation and release research; other search workloads may behave differently.
- Each pair ran once. Search results, model behavior, and network conditions can vary.
- The incumbent was specifically OpenAI, not the full automatic provider chain.
- Browser dependencies were resolved at run time because the candidate repository has no lockfile.
- The browser path was tested as the published skill. A purpose-built internal adapter could use fewer turns and avoid printing large pages into context.
- 2 tool calls failed and recovered during the pilot (q06 browser, q09 browser). Their retries remain in the measured time and token totals.

## Evidence

- Compact machine-readable results and redacted tool audit: [`pilot-results.json`](./pilot-results.json)
- Fixed questions: [`questions.json`](./questions.json)
- Runner: [`run.mjs`](./run.mjs)
- Judge workflow: [`judge-workflow.js`](./judge-workflow.js)
- Full raw trace remains locally under `benchmarks/web-search/runs/` and is intentionally ignored by Git.
