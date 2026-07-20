import { createHash } from "node:crypto";

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rounded(value) {
	return Number(value.toFixed(12));
}

/** Sum requesting-agent usage across every assistant turn in one benchmark session. */
export function aggregateAssistantUsage(messages) {
	const totals = {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	for (const message of messages) {
		if (message?.role !== "assistant" || !message.usage) {
			continue;
		}
		const usage = message.usage;
		totals.turns += 1;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
			totals[key] += finiteNumber(usage[key]);
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
			totals.cost[key] += finiteNumber(usage.cost?.[key]);
		}
	}

	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
		totals.cost[key] = rounded(totals.cost[key]);
	}
	return totals;
}

function normalizeOpenAIUsage(response) {
	const usage = response?.usage;
	if (!usage || typeof usage !== "object") {
		return null;
	}
	return {
		model: typeof response.model === "string" ? response.model : "unknown",
		inputTokens: finiteNumber(usage.input_tokens),
		outputTokens: finiteNumber(usage.output_tokens),
		totalTokens: finiteNumber(usage.total_tokens),
		cachedInputTokens: finiteNumber(usage.input_tokens_details?.cached_tokens),
		reasoningTokens: finiteNumber(usage.output_tokens_details?.reasoning_tokens),
	};
}

function textFromContent(content) {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(part => part?.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n")
		.trim();
}

/** Return the final non-empty assistant text while excluding reasoning and tool messages. */
export function extractFinalAnswer(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") {
			continue;
		}
		const text = textFromContent(message.content);
		if (text) {
			return text;
		}
	}
	return "";
}

/** Parse token usage from a JSON or SSE OpenAI Responses payload. */
export function extractOpenAIResponseUsage(text) {
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (!trimmed) {
		return null;
	}

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			return normalizeOpenAIUsage(parsed?.response ?? parsed);
		} catch {
			return null;
		}
	}

	let completed = null;
	for (const line of trimmed.split("\n")) {
		if (!line.startsWith("data: ")) {
			continue;
		}
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") {
			continue;
		}
		try {
			const event = JSON.parse(data);
			if ((event.type === "response.completed" || event.type === "response.done") && event.response) {
				completed = event.response;
			}
		} catch {
			// Ignore non-JSON SSE events; only a completed response carries final usage.
		}
	}
	return normalizeOpenAIUsage(completed);
}

function median(values) {
	if (values.length === 0) {
		return 0;
	}
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Aggregate system-level usage, latency, and tool-activity measurements. */
export function summarizeBenchmarkResults(records) {
	const summary = {};
	for (const system of ["incumbent", "browser"]) {
		const selected = records.filter(record => record.system === system);
		const providerTokens = selected.reduce((total, record) => total + (record.providerCaptures ?? [])
			.reduce((captureTotal, capture) => captureTotal + finiteNumber(capture.usage?.totalTokens), 0), 0);
		const agentTokens = selected.reduce((total, record) => total + finiteNumber(record.usage?.totalTokens), 0);
		const durations = selected.map(record => finiteNumber(record.durationMs));
		summary[system] = {
			questions: selected.length,
			successes: selected.filter(record => record.success).length,
			agentTokens,
			providerTokens,
			knownModelTokens: agentTokens + providerTokens,
			inputTokens: selected.reduce((total, record) => total + finiteNumber(record.usage?.input), 0),
			outputTokens: selected.reduce((total, record) => total + finiteNumber(record.usage?.output), 0),
			cacheReadTokens: selected.reduce((total, record) => total + finiteNumber(record.usage?.cacheRead), 0),
			reasoningTokens: selected.reduce((total, record) => total + finiteNumber(record.usage?.reasoning), 0),
			agentCost: rounded(selected.reduce((total, record) => total + finiteNumber(record.usage?.cost?.total), 0)),
			durationMs: durations.reduce((total, duration) => total + duration, 0),
			medianDurationMs: median(durations),
			turns: selected.reduce((total, record) => total + finiteNumber(record.usage?.turns), 0),
			toolCalls: selected.reduce((total, record) => total + (record.toolCalls?.length ?? 0), 0),
			toolResultChars: selected.reduce((total, record) => total + (record.toolCalls ?? [])
				.reduce((callTotal, call) => callTotal + (call.resultText?.length ?? 0), 0), 0),
			answerChars: selected.reduce((total, record) => total + (record.finalAnswer?.length ?? 0), 0),
		};
	}
	return summary;
}

/** Apply the unified judge result and restore anonymous answer positions to system names. */
export function resolveTournamentResults(judgeResults, privateMap) {
	return judgeResults.map(item => {
		const winnerPosition = item.finalWinner;
		const winnerSystem = winnerPosition === -1 || winnerPosition === undefined || winnerPosition === null
			? null
			: privateMap[item.id]?.[`answer${winnerPosition}`] ?? null;
		return {
			id: item.id,
			winnerPosition: winnerPosition ?? null,
			winnerSystem,
			decision: item.decision ?? "unresolved",
			reason: item.adjudication?.reason ?? item.openai?.reason ?? item.glm?.reason ?? "No decision",
		};
	});
}

/** Hash every experiment-defining input so resumed runs cannot mix configurations. */
export function createRunIdentity(input) {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Reject browser runs that mutate the pinned dependency environment. */
export function validateBrowserRoute(toolCalls) {
	const installPattern = /(?:^|[;&|]\s*)(?:bun|npm|pnpm|yarn)\s+(?:i|install|add|update|upgrade)\b/;
	const mutation = toolCalls.find(call => call.name === "bash"
		&& typeof call.args?.command === "string"
		&& installPattern.test(call.args.command));
	return mutation ? "Browser path must not install or update dependencies during collection." : null;
}

/** Require every incumbent search call to select OpenAI without auto-summary. */
export function validateIncumbentRoute(toolCalls) {
	const searchCalls = toolCalls.filter(call => call.name === "web_search");
	if (searchCalls.length === 0) {
		return "Incumbent path did not call web_search.";
	}
	if (searchCalls.some(call => call.args?.provider !== "openai")) {
		return 'Incumbent web_search must set provider="openai".';
	}
	if (searchCalls.some(call => call.args?.workflow !== "none")) {
		return 'Incumbent web_search must set workflow="none".';
	}
	return null;
}

/** Counterbalance paired answers and retain a separate private scoring map. */
export function buildBlindPairs(questions, records) {
	const publicPairs = [];
	const privateMap = {};

	for (const [index, question] of questions.entries()) {
		const incumbent = records.find(record => record.questionId === question.id && record.system === "incumbent");
		const browser = records.find(record => record.questionId === question.id && record.system === "browser");
		if (!incumbent || !browser) {
			throw new Error(`Missing paired benchmark records for ${question.id}`);
		}
		const ordered = index % 2 === 0 ? [incumbent, browser] : [browser, incumbent];
		publicPairs.push({
			id: question.id,
			question: question.question,
			answer0: ordered[0].finalAnswer,
			answer1: ordered[1].finalAnswer,
		});
		privateMap[question.id] = { answer0: ordered[0].system, answer1: ordered[1].system };
	}

	return { publicPairs, privateMap };
}
