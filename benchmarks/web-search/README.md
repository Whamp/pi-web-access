# Web search benchmark

This benchmark compares:

1. **Incumbent:** pi-web-access with `provider: "openai"` and `workflow: "none"`.
2. **Browser:** ogulcancelik's published `web-search` skill and CLI.

Each system answers the same questions in fresh Pi sessions with the same requesting model. The runner records final answers, model usage, hidden OpenAI search usage, latency, turns, tool calls, and failures.

The pilot results are in [`PILOT-REPORT.md`](./PILOT-REPORT.md).

## Requirements

- Node.js 24 or later
- A working Pi login for `openai-codex/gpt-5.6-luna`
- Git and npm
- Chrome, Brave, Edge, or Chromium
- Network access

The runner pins the candidate source commit and uses [`candidate-package-lock.json`](./candidate-package-lock.json) for a clean `npm ci` in an isolated cache. It rejects package-manager commands or dependency-tree changes during collection.

## Collect answers

```bash
node benchmarks/web-search/run.mjs \
  --output benchmarks/web-search/runs/pilot.json
```

Useful options:

```bash
# Resume after interruption; completed answer pairs are kept.
node benchmarks/web-search/run.mjs \
  --output benchmarks/web-search/runs/pilot.json \
  --resume

# Run one question or one path while developing the harness.
node benchmarks/web-search/run.mjs \
  --questions q02 \
  --systems incumbent \
  --output /tmp/incumbent-smoke.json

# Clone the pinned commit from an inspected local candidate checkout.
# The checkout itself is not modified.
node benchmarks/web-search/run.mjs \
  --candidate-dir /path/to/agent-skills \
  --output benchmarks/web-search/runs/pilot.json
```

The runner writes after every answer. It also creates:

- `pilot.blind.json`: anonymous answer pairs for judges
- `pilot.map.json`: private answer-position mapping

`--resume` accepts only an identical experiment. The runner hashes the model, thinking level, source revisions, resolved candidate dependencies, selected systems, and questions; a mismatch stops instead of mixing records.

Files under `runs/` are ignored because the full trace is large. The report generator writes the compact, reviewable result to `pilot-results.json`.

## Judge answers

[`judge-workflow.js`](./judge-workflow.js) runs two independent judges per anonymous pair: OpenAI and GLM. It calls an OpenAI adjudicator only when they disagree.

Pass the parsed `pilot.blind.json` array as `args.pairs` to pi-dynamic-workflows. Recommended run bounds:

```text
maxAgents: 30
concurrency: 4
agentRetries: 1
agentTimeoutMs: 300000
```

The workflow returns one versioned object containing both initial judgments and any adjudications. Save that object beside the raw run as `pilot.judges.json`; the reporter consumes it directly. Workflow usage is optional in this artifact; add `{ "usage": { "tokens": ..., "cost": ... } }` when the caller reports it.

The pilot's 20 initial judgments used 968,231 tokens. A 150,000-token soft gate did not prevent concurrent in-flight calls from overshooting, so budget this stage separately from the systems being compared.

Judges receive only anonymous answers. Do not give them `pilot.map.json`. [`quality-gates.json`](./quality-gates.json) applies deterministic required-source checks after judging; this catches answers that confidently cite the wrong project.

## Generate the report

```bash
node benchmarks/web-search/report.mjs \
  benchmarks/web-search/runs/pilot.json

# Optional second argument: output directory for generated artifacts.
node benchmarks/web-search/report.mjs \
  benchmarks/web-search/runs/pilot.json \
  /tmp/web-search-report
```

This writes:

- `benchmarks/web-search/pilot-results.json`
- `benchmarks/web-search/PILOT-REPORT.md`

## Validate the harness

```bash
node --test test/web-search-benchmark.test.mjs
npm test
```
