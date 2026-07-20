import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
	aggregateAssistantUsage,
	buildBlindPairs,
	createRunIdentity,
	extractFinalAnswer,
	extractOpenAIResponseUsage,
	resolveTournamentResults,
	summarizeBenchmarkResults,
	validateBrowserRoute,
	validateIncumbentRoute,
} from "../benchmarks/web-search/benchmark-lib.mjs";

test("benchmark totals every requesting-agent turn without hiding cache or reasoning usage", () => {
	const messages = [
		{
			role: "assistant",
			usage: {
				input: 120,
				output: 30,
				cacheRead: 80,
				cacheWrite: 10,
				reasoning: 12,
				totalTokens: 240,
				cost: { input: 0.12, output: 0.06, cacheRead: 0.01, cacheWrite: 0.02, total: 0.21 },
			},
		},
		{ role: "toolResult", content: [{ type: "text", text: "evidence" }] },
		{
			role: "assistant",
			usage: {
				input: 60,
				output: 20,
				cacheRead: 140,
				cacheWrite: 0,
				reasoning: 8,
				totalTokens: 220,
				cost: { input: 0.06, output: 0.04, cacheRead: 0.02, cacheWrite: 0, total: 0.12 },
			},
		},
	];

	assert.deepEqual(aggregateAssistantUsage(messages), {
		turns: 2,
		input: 180,
		output: 50,
		cacheRead: 220,
		cacheWrite: 10,
		reasoning: 20,
		totalTokens: 460,
		cost: { input: 0.18, output: 0.1, cacheRead: 0.03, cacheWrite: 0.02, total: 0.33 },
	});
});

test("benchmark extracts only the final assistant answer", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", name: "web_search" }] },
		{ role: "toolResult", content: [{ type: "text", text: "raw evidence" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Final answer with a source." }] },
	];

	assert.equal(extractFinalAnswer(messages), "Final answer with a source.");
});

test("benchmark recovers provider token usage from an OpenAI streamed completion", () => {
	const stream = [
		'data: {"type":"response.output_item.done","item":{"type":"web_search_call"}}',
		'data: {"type":"response.completed","response":{"model":"gpt-5.4","usage":{"input_tokens":812,"output_tokens":144,"total_tokens":956,"input_tokens_details":{"cached_tokens":256},"output_tokens_details":{"reasoning_tokens":40}}}}',
		"data: [DONE]",
	].join("\n\n");

	assert.deepEqual(extractOpenAIResponseUsage(stream), {
		model: "gpt-5.4",
		inputTokens: 812,
		outputTokens: 144,
		totalTokens: 956,
		cachedInputTokens: 256,
		reasoningTokens: 40,
	});
});

test("benchmark report separates agent and provider tokens and unblinds winners", () => {
	const records = [
		{
			questionId: "q1", system: "incumbent", success: true, durationMs: 100,
			finalAnswer: "a", usage: { turns: 2, totalTokens: 100, input: 70, output: 30, cacheRead: 0, reasoning: 10, cost: { total: 0.1 } },
			providerCaptures: [{ usage: { totalTokens: 40 } }], toolCalls: [{ resultText: "raw" }],
		},
		{
			questionId: "q1", system: "browser", success: true, durationMs: 80,
			finalAnswer: "b", usage: { turns: 1, totalTokens: 120, input: 90, output: 30, cacheRead: 0, reasoning: 8, cost: { total: 0.12 } },
			providerCaptures: [], toolCalls: [{ resultText: "raw browser" }],
		},
	];
	const summary = summarizeBenchmarkResults(records);
	assert.equal(summary.incumbent.agentTokens, 100);
	assert.equal(summary.incumbent.providerTokens, 40);
	assert.equal(summary.incumbent.knownModelTokens, 140);
	assert.equal(summary.browser.knownModelTokens, 120);

	const judgeResults = [{
		id: "q1",
		openai: { winner: 1, reason: "first" },
		glm: { winner: 0, reason: "second" },
		agreement: false,
		adjudication: { winner: 1, reason: "better" },
		finalWinner: 1,
		decision: "adjudicated",
	}];
	const map = { q1: { answer0: "browser", answer1: "incumbent" } };
	assert.deepEqual(resolveTournamentResults(judgeResults, map), [
		{ id: "q1", winnerPosition: 1, winnerSystem: "incumbent", decision: "adjudicated", reason: "better" },
	]);
});

test("benchmark resume identity changes with any experiment-defining input", () => {
	const input = {
		projectCommit: "abc",
		candidateCommit: "def",
		candidateDependencies: "deps",
		model: "provider/model",
		thinking: "high",
		systems: ["incumbent", "browser"],
		questions: [{ id: "q1", question: "Question?", asOf: "2026-01-01" }],
	};
	assert.equal(createRunIdentity(input), createRunIdentity({ ...input }));
	assert.notEqual(createRunIdentity(input), createRunIdentity({ ...input, thinking: "low" }));
});

test("benchmark rejects browser runs that install or update dependencies", () => {
	assert.equal(validateBrowserRoute([
		{ name: "bash", args: { command: "node web-search.js query" } },
	]), null);
	assert.match(validateBrowserRoute([
		{ name: "bash", args: { command: "bun install" } },
	]), /must not install or update dependencies/);
});

test("benchmark rejects incumbent runs that did not explicitly use OpenAI without auto-summary", () => {
	assert.equal(validateIncumbentRoute([
		{ name: "web_search", args: { provider: "openai", workflow: "none" } },
	]), null);
	assert.match(validateIncumbentRoute([]), /did not call web_search/);
	assert.match(validateIncumbentRoute([
		{ name: "web_search", args: { provider: "auto", workflow: "none" } },
	]), /provider="openai"/);
	assert.match(validateIncumbentRoute([
		{ name: "web_search", args: { provider: "openai", workflow: "auto-summary" } },
	]), /workflow="none"/);
});

test("runner help and judge workflow load without starting paid work", async () => {
	const help = spawnSync(process.execPath, ["benchmarks/web-search/run.mjs", "--help"], {
		cwd: process.cwd(), encoding: "utf8",
	});
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--resume/);

	const workflowSource = (await readFile("benchmarks/web-search/judge-workflow.js", "utf8"))
		.replace("export const meta", "const meta");
	const directory = await mkdtemp(join(tmpdir(), "pi-web-search-workflow-syntax-"));
	const wrappedPath = join(directory, "wrapped-workflow.js");
	await writeFile(wrappedPath, `async function workflow(args, agent, parallel, phase) {\n${workflowSource}\n}\n`);
	const syntax = spawnSync(process.execPath, ["--check", wrappedPath], { encoding: "utf8" });
	assert.equal(syntax.status, 0, syntax.stderr);
});

test("reporter consumes the unified judge workflow result", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-search-report-"));
	const runPath = join(directory, "fixture.json");
	const score = { correctness: 5, completeness: 5, sourceQuality: 5, directness: 5 };
	const record = (system, answer) => ({
		questionId: "q1", system, success: true, durationMs: 100, finalAnswer: answer,
		usage: { turns: 1, totalTokens: 10, input: 7, output: 3, cacheRead: 0, reasoning: 1, cost: { total: 0.01 } },
		providerCaptures: [], toolCalls: [{
			name: system === "incumbent" ? "web_search" : "bash",
			args: system === "incumbent" ? { provider: "openai", workflow: "none" } : {},
			durationMs: 10, isError: false, resultText: "evidence",
		}],
	});
	await writeFile(runPath, JSON.stringify({
		runIdentity: "fixture-identity", projectCommit: "abc", model: "provider/model", thinking: "high",
		candidate: { repository: "candidate", commit: "def", skillDir: "/candidate", lockfileDigest: "lock", dependencies: "{}" },
		questions: [{ id: "q1", category: "fixture", asOf: "2026-01-01", question: "Question?" }],
		records: [record("incumbent", "Answer A"), { ...record("browser", "Answer B"), browserTemperature: "cold" }],
	}));
	await writeFile(join(directory, "fixture.map.json"), JSON.stringify({ q1: { answer0: "incumbent", answer1: "browser" } }));
	await writeFile(join(directory, "fixture.judges.json"), JSON.stringify({
		version: 1,
		results: [{
			id: "q1", openai: { winner: 1, answer0: score, answer1: score, reason: "B" },
			glm: { winner: 1, answer0: score, answer1: score, reason: "B" }, agreement: true,
			adjudication: null, finalWinner: 1, decision: "agreement",
		}],
		coverage: { disputes: 0 }, usage: { tokens: 20, cost: 0.02 },
	}));

	const child = spawnSync(process.execPath, ["benchmarks/web-search/report.mjs", runPath, directory], {
		cwd: process.cwd(), encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	const results = JSON.parse(await readFile(join(directory, "pilot-results.json"), "utf8"));
	assert.deepEqual(results.quality.counts, { incumbent: 0, browser: 1, tie: 0, unresolved: 0 });
	const report = await readFile(join(directory, "PILOT-REPORT.md"), "utf8");
	assert.match(report, /preferred final answer on \*\*1\/1\*\*/);
});

test("benchmark blinds paired answers while retaining a private scoring map", () => {
	const records = [
		{ questionId: "q1", system: "incumbent", finalAnswer: "alpha one" },
		{ questionId: "q1", system: "browser", finalAnswer: "beta one" },
		{ questionId: "q2", system: "incumbent", finalAnswer: "alpha two" },
		{ questionId: "q2", system: "browser", finalAnswer: "beta two" },
	];
	const questions = [
		{ id: "q1", question: "Question one?" },
		{ id: "q2", question: "Question two?" },
	];

	const { publicPairs, privateMap } = buildBlindPairs(questions, records);

	assert.deepEqual(publicPairs, [
		{ id: "q1", question: "Question one?", answer0: "alpha one", answer1: "beta one" },
		{ id: "q2", question: "Question two?", answer0: "beta two", answer1: "alpha two" },
	]);
	assert.deepEqual(privateMap, {
		q1: { answer0: "incumbent", answer1: "browser" },
		q2: { answer0: "browser", answer1: "incumbent" },
	});
	assert.doesNotMatch(JSON.stringify(publicPairs), /incumbent|browser/);
});
