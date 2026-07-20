#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	resolveTournamentResults,
	summarizeBenchmarkResults,
	validateIncumbentRoute,
} from "./benchmark-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function percentDifference(value, baseline) {
	if (!baseline) {
		return null;
	}
	return ((value - baseline) / baseline) * 100;
}

function formatNumber(value) {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function formatPercent(value) {
	return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatSeconds(milliseconds) {
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

function sanitizeText(text, candidatePath) {
	if (typeof text !== "string") {
		return text;
	}
	const withoutCandidate = candidatePath ? text.replaceAll(candidatePath, "<candidate>") : text;
	return withoutCandidate
		.replaceAll(homedir(), "<home>")
		.replace(/\/tmp\/pi-[A-Za-z0-9._/-]+/g, "<temp>");
}

function sanitizeArguments(args, candidatePath) {
	if (args === null || args === undefined) {
		return null;
	}
	const serialized = sanitizeText(JSON.stringify(args), candidatePath);
	return JSON.parse(serialized);
}

function compactToolCalls(record, candidatePath) {
	return record.toolCalls.map(call => ({
		name: call.name,
		args: sanitizeArguments(call.args, candidatePath),
		durationMs: call.durationMs,
		isError: call.isError,
		resultChars: call.resultText?.length ?? 0,
		...(call.isError ? { errorExcerpt: sanitizeText(call.resultText?.slice(0, 300) ?? "", candidatePath) } : {}),
	}));
}

async function main() {
	const runPath = resolve(process.argv[2] ?? join(HERE, "runs", "pilot.json"));
	const outputDirectory = resolve(process.argv[3] ?? HERE);
	const runBasePath = runPath.replace(/\.json$/i, "");
	const benchmarkRun = JSON.parse(await readFile(runPath, "utf8"));
	const privateAnswerMap = JSON.parse(await readFile(`${runBasePath}.map.json`, "utf8"));
	const judgeRun = JSON.parse(await readFile(`${runBasePath}.judges.json`, "utf8"));
	const qualityGates = JSON.parse(await readFile(join(HERE, "quality-gates.json"), "utf8"));
	if (typeof benchmarkRun.runIdentity !== "string" || benchmarkRun.runIdentity.length === 0) {
		throw new Error("Benchmark run is missing its v2 experiment identity; rerun collection before reporting.");
	}
	if (judgeRun.version !== 1 || !Array.isArray(judgeRun.results)) {
		throw new Error("Judge artifact does not match version 1 of the benchmark judge schema.");
	}
	for (const record of benchmarkRun.records.filter(item => item.system === "incumbent")) {
		const routeError = validateIncumbentRoute(record.toolCalls);
		if (routeError) {
			throw new Error(`${record.questionId}: ${routeError}`);
		}
	}
	const excludedQuestionIds = new Set(qualityGates.excludedQuestionIds ?? []);
	const includedQuestions = benchmarkRun.questions.filter(question => !excludedQuestionIds.has(question.id));
	const includedRecords = benchmarkRun.records.filter(record => !excludedQuestionIds.has(record.questionId));
	const summary = summarizeBenchmarkResults(includedRecords);
	const judgedQuality = resolveTournamentResults(judgeRun.results, privateAnswerMap)
		.filter(result => !excludedQuestionIds.has(result.id));
	const quality = judgedQuality.map(result => {
		const requiredCitation = qualityGates.requiredCitationSubstrings?.[result.id];
		if (!requiredCitation) {
			return result;
		}
		const passedPositions = [0, 1].filter(position => {
			const system = privateAnswerMap[result.id][`answer${position}`];
			const record = benchmarkRun.records.find(item => item.questionId === result.id && item.system === system);
			return record?.finalAnswer.toLowerCase().includes(requiredCitation.toLowerCase());
		});
		if (passedPositions.length === 2) {
			return result;
		}
		if (passedPositions.length === 0) {
			return {
				...result,
				winnerPosition: -1,
				winnerSystem: null,
				decision: "required-source-gate",
				reason: `Both answers failed the required source check: ${requiredCitation}`,
			};
		}
		const winnerPosition = passedPositions[0];
		return {
			...result,
			winnerPosition,
			winnerSystem: privateAnswerMap[result.id][`answer${winnerPosition}`],
			decision: "required-source-gate",
			reason: `Only one answer passed the required source check: ${requiredCitation}`,
		};
	});

	const dimensions = ["correctness", "completeness", "sourceQuality", "directness"];
	const scoreTotals = Object.fromEntries(["incumbent", "browser"].map(system => [system,
		Object.fromEntries(dimensions.map(dimension => [dimension, []])),
	]));
	for (const result of judgeRun.results.filter(item => !excludedQuestionIds.has(item.id))) {
		for (const judge of [result.openai, result.glm]) {
			if (!judge) {
				continue;
			}
			for (const position of [0, 1]) {
				const system = privateAnswerMap[result.id][`answer${position}`];
				for (const dimension of dimensions) {
					scoreTotals[system][dimension].push(judge[`answer${position}`][dimension]);
				}
			}
		}
	}
	const averageScores = Object.fromEntries(Object.entries(scoreTotals).map(([system, values]) => [system,
		Object.fromEntries(Object.entries(values).map(([dimension, scores]) => [dimension,
			scores.reduce((total, score) => total + score, 0) / scores.length,
		])),
	]));

	const qualityCounts = { incumbent: 0, browser: 0, tie: 0, unresolved: 0 };
	for (const result of quality) {
		if (result.winnerSystem) {
			qualityCounts[result.winnerSystem] += 1;
		} else if (result.winnerPosition === -1) {
			qualityCounts.tie += 1;
		} else {
			qualityCounts.unresolved += 1;
		}
	}

	const perQuestion = includedQuestions.map(question => {
		const records = Object.fromEntries(["incumbent", "browser"].map(system => [system,
			benchmarkRun.records.find(record => record.questionId === question.id && record.system === system),
		]));
		const qualityResult = quality.find(result => result.id === question.id);
		return {
			id: question.id,
			category: question.category,
			question: question.question,
			winner: qualityResult?.winnerSystem ?? (qualityResult?.winnerPosition === -1 ? "tie" : "unresolved"),
			decision: qualityResult?.decision ?? "unresolved",
			reason: qualityResult?.reason ?? "No decision",
			incumbent: {
				answer: records.incumbent.finalAnswer,
				agentTokens: records.incumbent.usage.totalTokens,
				providerTokens: records.incumbent.providerCaptures.reduce((total, capture) => total + (capture.usage?.totalTokens ?? 0), 0),
				durationMs: records.incumbent.durationMs,
				turns: records.incumbent.usage.turns,
				toolCalls: compactToolCalls(records.incumbent, benchmarkRun.candidate.skillDir),
				providerCaptures: records.incumbent.providerCaptures,
			},
			browser: {
				answer: records.browser.finalAnswer,
				agentTokens: records.browser.usage.totalTokens,
				providerTokens: 0,
				durationMs: records.browser.durationMs,
				turns: records.browser.usage.turns,
				toolCalls: compactToolCalls(records.browser, benchmarkRun.candidate.skillDir),
				temperature: records.browser.browserTemperature,
			},
		};
	});
	const toolFailures = perQuestion.flatMap(item => ["incumbent", "browser"].flatMap(system =>
		item[system].toolCalls
			.filter(call => call.isError)
			.map(call => ({ questionId: item.id, system, ...call })),
	));
	const browserColdStarts = perQuestion.filter(item => item.browser.temperature === "cold").length;
	const toolFailureLocations = toolFailures.map(failure => `${failure.questionId} ${failure.system}`).join(", ");
	const toolFailureNote = toolFailures.length === 0
		? "No tool calls failed during the pilot."
		: `${toolFailures.length} tool calls failed and recovered during the pilot (${toolFailureLocations}). Their retries remain in the measured time and token totals.`;
	const collectedQuestionCount = benchmarkRun.questions.length;
	const questionCount = includedQuestions.length;
	const judgeUsage = judgeRun.usage ?? { tokens: null, cost: null };
	const judgeUsageSentence = typeof judgeUsage.tokens === "number" && typeof judgeUsage.cost === "number"
		? `The judging itself used ${formatNumber(judgeUsage.tokens)} tokens and about $${judgeUsage.cost.toFixed(3)}.`
		: "The saved judge artifact did not include workflow token or cost metadata.";

	const results = {
		version: 2,
		benchmarkDate: benchmarkRun.questions[0]?.asOf ?? null,
		runIdentity: benchmarkRun.runIdentity,
		projectCommit: benchmarkRun.projectCommit,
		candidate: {
			repository: benchmarkRun.candidate.repository,
			commit: benchmarkRun.candidate.commit,
			lockfileDigest: benchmarkRun.candidate.lockfileDigest,
			dependencies: JSON.parse(benchmarkRun.candidate.dependencies),
		},
		requestingModel: benchmarkRun.model,
		thinking: benchmarkRun.thinking,
		quality: {
			counts: qualityCounts,
			rawAverageJudgeScores: averageScores,
			gates: qualityGates,
			judgeWorkflow: judgeUsage,
			coverage: { ...judgeRun.coverage, analyzedPairs: questionCount },
		},
		systems: summary,
		toolFailures,
		perQuestion,
	};

	const incumbent = summary.incumbent;
	const browser = summary.browser;
	const report = `# Web search benchmark pilot

## Bottom line

After excluding the three GitHub-fetch questions, the browser skill produced the preferred final answer on **${qualityCounts.browser}/${questionCount}** questions; the incumbent OpenAI path won **${qualityCounts.incumbent}/${questionCount}**, with **${qualityCounts.tie} ${qualityCounts.tie === 1 ? "tie" : "ties"}**. Both systems completed every retained question.

That quality gain was not token-efficient in the requesting chat. The browser path used **${formatNumber(browser.agentTokens)}** requesting-agent tokens versus **${formatNumber(incumbent.agentTokens)}** for the incumbent (**${formatPercent(percentDifference(browser.agentTokens, incumbent.agentTokens))}**). Even after adding the incumbent's captured hidden OpenAI search usage, the browser path used **${formatPercent(percentDifference(browser.knownModelTokens, incumbent.knownModelTokens))}** more known model tokens: **${formatNumber(browser.knownModelTokens)}** versus **${formatNumber(incumbent.knownModelTokens)}**.

**Recommendation:** keep the incumbent as the default. Trial the browser backend as a fallback or borrow its source-selection approach, but do not promote the skill as-is on token-efficiency grounds.

## Controlled setup

- ${collectedQuestionCount} fixed web-research questions were collected; ${questionCount} are analyzed after excluding ${[...excludedQuestionIds].join(", ")}.
- Same requesting model: \`${benchmarkRun.model}:${benchmarkRun.thinking}\`.
- Incumbent: this repository's registered tools. Every recorded search call was validated as \`provider: "openai"\` and \`workflow: "none"\`.
- Browser: ogulcancelik/agent-skills at \`${benchmarkRun.candidate.commit}\`, with the benchmark forcing search and retrieval through its CLI.
- Fresh in-memory Pi session for every answer; path order alternated by question.
- All retained browser runs were warm; the excluded q01 run contained the recorded cold start.
- Two anonymous judges per answer pair (OpenAI + GLM); adjudication resolved ${judgeRun.coverage.disputes} ${judgeRun.coverage.disputes === 1 ? "disagreement" : "disagreements"}.

## System measurements

| Metric | Incumbent | Browser | Browser vs incumbent |
| --- | ---: | ---: | ---: |
| Completed answers | ${incumbent.successes}/${incumbent.questions} | ${browser.successes}/${browser.questions} | — |
| Requesting-agent tokens | ${formatNumber(incumbent.agentTokens)} | ${formatNumber(browser.agentTokens)} | ${formatPercent(percentDifference(browser.agentTokens, incumbent.agentTokens))} |
| Hidden search-provider tokens | ${formatNumber(incumbent.providerTokens)} | 0 | — |
| Known model tokens | ${formatNumber(incumbent.knownModelTokens)} | ${formatNumber(browser.knownModelTokens)} | ${formatPercent(percentDifference(browser.knownModelTokens, incumbent.knownModelTokens))} |
| Requesting-agent cost | $${incumbent.agentCost.toFixed(3)} | $${browser.agentCost.toFixed(3)} | ${formatPercent(percentDifference(browser.agentCost, incumbent.agentCost))} |
| Median answer time | ${formatSeconds(incumbent.medianDurationMs)} | ${formatSeconds(browser.medianDurationMs)} | ${formatPercent(percentDifference(browser.medianDurationMs, incumbent.medianDurationMs))} |
| Total answer time | ${formatSeconds(incumbent.durationMs)} | ${formatSeconds(browser.durationMs)} | ${formatPercent(percentDifference(browser.durationMs, incumbent.durationMs))} |
| Agent turns | ${incumbent.turns} | ${browser.turns} | ${formatPercent(percentDifference(browser.turns, incumbent.turns))} |
| Tool calls | ${incumbent.toolCalls} | ${browser.toolCalls} | ${formatPercent(percentDifference(browser.toolCalls, incumbent.toolCalls))} |
| Tool-result characters | ${formatNumber(incumbent.toolResultChars)} | ${formatNumber(browser.toolResultChars)} | ${formatPercent(percentDifference(browser.toolResultChars, incumbent.toolResultChars))} |

The incumbent's hidden search-provider token count was captured from the OpenAI Responses stream. Its monetary cost is not exposed when using the Codex subscription, so the cost row covers only the shared requesting model. Browser CPU and memory costs were not priced.

## Answer quality

| Result | Count |
| --- | ---: |
| Browser preferred | ${qualityCounts.browser} |
| Incumbent preferred | ${qualityCounts.incumbent} |
| Tie | ${qualityCounts.tie} |
| Unresolved | ${qualityCounts.unresolved} |

Where the judges separated the retained pairs, browser answers were usually more complete and better sourced. ${judgeUsageSentence} That figure covers judging the original ten pairs; judge usage is excluded from both systems' measurements.

## Per-question results

| Question | Winner | Incumbent agent / provider tokens | Browser agent tokens | Incumbent time | Browser time |
| --- | --- | ---: | ---: | ---: | ---: |
${perQuestion.map(item => `| ${item.id} — ${item.category} | ${item.winner} | ${formatNumber(item.incumbent.agentTokens)} / ${formatNumber(item.incumbent.providerTokens)} | ${formatNumber(item.browser.agentTokens)} | ${formatSeconds(item.incumbent.durationMs)} | ${formatSeconds(item.browser.durationMs)} |`).join("\n")}

## Important limits

- This is a seven-question recalculation of a ten-question pilot, not a statistically stable benchmark.
- Questions emphasize technical documentation and release research; other search workloads may behave differently.
- Each pair ran once. Search results, model behavior, and network conditions can vary.
- The incumbent was specifically OpenAI, not the full automatic provider chain.
- The candidate repository has no lockfile. This benchmark supplied a committed lockfile and used a clean \`npm ci\` before collection.
- The original browser prompt incorrectly prohibited \`curl\`, \`wget\`, and other retrieval routes even though the skill recommends \`gh\` for GitHub and \`curl\` for simple URLs. Excluding the three direct-GitHub questions removes the clearest distortion, but the remaining comparison is still provisional rather than a faithful as-published test.
- ${toolFailureNote}

## Evidence

- Compact machine-readable results and redacted tool audit: [\`pilot-results.json\`](./pilot-results.json)
- Fixed questions: [\`questions.json\`](./questions.json)
- Runner: [\`run.mjs\`](./run.mjs)
- Judge workflow: [\`judge-workflow.js\`](./judge-workflow.js)
- Full raw trace remains locally under \`benchmarks/web-search/runs/\` and is intentionally ignored by Git.
`;

	await mkdir(outputDirectory, { recursive: true });
	await writeFile(join(outputDirectory, "pilot-results.json"), `${JSON.stringify(results, null, 2)}\n`);
	await writeFile(join(outputDirectory, "PILOT-REPORT.md"), report);
	process.stdout.write(`${join(outputDirectory, "PILOT-REPORT.md")}\n`);
}

await main();
