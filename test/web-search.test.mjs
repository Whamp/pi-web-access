import assert from "node:assert/strict";
import fc from "fast-check";
import { test } from "node:test";
import { AutoSearchError, createWebSearch, ProviderIneligibleError } from "../web-search.ts";

const PROVIDER_NAMES = ["openai", "exa", "brave", "parallel", "tavily", "perplexity", "gemini"];

function createFakeProvider(name, overrides = {}, callLog = [], eligibilityLog = []) {
	let attempts = 0;
	let eligibilityChecks = 0;
	return {
		name,
		label: name === "openai" ? "OpenAI" : name[0].toUpperCase() + name.slice(1),
		eligibility: async (request) => {
			eligibilityChecks += 1;
			eligibilityLog.push(name);
			if (overrides.eligibilityOperation) return overrides.eligibilityOperation(request);
			if (overrides.eligibilityError) throw overrides.eligibilityError;
			return overrides.eligibility ?? { eligible: true };
		},
		search: async (request) => {
			attempts += 1;
			callLog.push(name);
			if (overrides.search) return overrides.search(request);
			if (overrides.error) throw overrides.error;
			return overrides.result ?? { answer: `${name} answer`, results: [] };
		},
		attempts: () => attempts,
		eligibilityChecks: () => eligibilityChecks,
	};
}

function createFixture(overrides = {}) {
	const callLog = [];
	const eligibilityLog = [];
	const providers = Object.fromEntries(PROVIDER_NAMES.map(
		(name) => [name, createFakeProvider(name, overrides[name], callLog, eligibilityLog)],
	));
	return { callLog, eligibilityLog, providers, webSearch: createWebSearch(providers) };
}

test("eligibility reports every provider without executing a search", async () => {
	const { providers, webSearch } = createFixture({
		brave: { eligibility: { eligible: false, reason: "Brave key missing" } },
	});

	const eligibility = await webSearch.eligibility();

	assert.deepEqual(eligibility.brave, { eligible: false, reason: "Brave key missing" });
	assert.deepEqual(Object.keys(eligibility), PROVIDER_NAMES);
	assert.ok(PROVIDER_NAMES.every((name) => providers[name].attempts() === 0));
});

test("a saved Brave selection stays strict when its key is removed", async () => {
	const originalError = new Error("Brave request failed");
	const success = createFixture();
	const failure = createFixture({ brave: { error: originalError } });
	const ineligible = createFixture({
		brave: { eligibility: { eligible: false, reason: "Brave key missing" } },
	});

	const result = await success.webSearch.search("query", { provider: "brave" });
	assert.equal(result.provider, "brave");
	assert.equal(success.providers.brave.attempts(), 1);
	assert.ok(PROVIDER_NAMES.filter((name) => name !== "brave").every((name) => success.providers[name].attempts() === 0));

	await assert.rejects(failure.webSearch.search("query", { provider: "brave" }), (error) => error === originalError);
	assert.equal(failure.providers.brave.attempts(), 1);
	assert.ok(PROVIDER_NAMES.filter((name) => name !== "brave").every((name) => failure.providers[name].attempts() === 0));

	await assert.rejects(ineligible.webSearch.search("query", { provider: "brave" }), (error) => {
		assert.ok(error instanceof ProviderIneligibleError);
		assert.equal(error.provider, "brave");
		assert.equal(error.reason, "Brave key missing");
		return true;
	});
	assert.ok(PROVIDER_NAMES.every((name) => ineligible.providers[name].attempts() === 0));
});

test("auto uses fixed order, skips ineligible providers, and continues after provider-owned aborts", async () => {
	const { callLog, webSearch } = createFixture({
		openai: { error: new Error("OpenAI failed") },
		exa: { eligibility: { eligible: false, reason: "Exa unavailable" } },
		brave: { error: new DOMException("provider timeout", "AbortError") },
	});

	const result = await webSearch.search("query", { provider: "auto" });

	assert.deepEqual(callLog, ["openai", "brave", "parallel"]);
	assert.equal(result.provider, "parallel");
});

test("OpenAI auto policy gate does not change eligibility or explicit OpenAI selection", async () => {
	const auto = createFixture();
	const explicit = createFixture();

	assert.deepEqual((await auto.webSearch.eligibility()).openai, { eligible: true });
	const autoResult = await auto.webSearch.search("query", { provider: "auto", recencyFilter: "week" });
	const explicitResult = await explicit.webSearch.search("query", { provider: "openai", recencyFilter: "week", numResults: 2 });

	assert.deepEqual(auto.callLog, ["exa"]);
	assert.equal(autoResult.provider, "exa");
	assert.deepEqual(explicit.callLog, ["openai"]);
	assert.equal(explicitResult.provider, "openai");
});

test("caller cancellation stops auto immediately and propagates the caller reason", async () => {
	const controller = new AbortController();
	const callerReason = new Error("caller cancelled");
	const running = createFixture({
		openai: {
			search: async () => {
				controller.abort(callerReason);
				throw new DOMException("provider observed cancellation", "AbortError");
			},
		},
	});

	await assert.rejects(
		running.webSearch.search("query", { provider: "auto", signal: controller.signal }),
		(error) => error === callerReason,
	);
	assert.deepEqual(running.callLog, ["openai"]);

	const alreadyAborted = new AbortController();
	const initialReason = new Error("cancelled before search");
	alreadyAborted.abort(initialReason);
	const notStarted = createFixture();
	await assert.rejects(
		notStarted.webSearch.search("query", { provider: "auto", signal: alreadyAborted.signal }),
		(error) => error === initialReason,
	);
	assert.deepEqual(notStarted.callLog, []);
});

test("auto aggregate failures preserve order, attribution, original errors, and public text", async () => {
	const openaiError = new Error("openai down");
	const braveError = new Error("brave down");
	const parallelError = new Error("parallel down");
	const { webSearch } = createFixture({
		openai: { error: openaiError },
		exa: { eligibility: { eligible: false, reason: "skip" } },
		brave: { error: braveError },
		parallel: { error: parallelError },
		tavily: { eligibility: { eligible: false, reason: "skip" } },
		perplexity: { eligibility: { eligible: false, reason: "skip" } },
		gemini: { eligibility: { eligible: false, reason: "skip" } },
	});

	await assert.rejects(webSearch.search("query", { provider: "auto" }), (error) => {
		assert.ok(error instanceof AutoSearchError);
		assert.equal(error.message, "Auto provider search failed:\n  - OpenAI: openai down\n  - Brave: brave down\n  - Parallel: parallel down");
		assert.deepEqual(error.failures.map((failure) => failure.provider), ["openai", "brave", "parallel"]);
		assert.equal(error.failures[0].error, openaiError);
		assert.equal(error.failures[1].error, braveError);
		assert.equal(error.failures[2].error, parallelError);
		return true;
	});
});

test("property: named selection is strict and attempts only the selected eligible provider", async () => {
	const statusArbitrary = fc.constantFrom("ineligible", "eligibility-failure", "search-failure", "success");
	await fc.assert(fc.asyncProperty(
		fc.constantFrom(...PROVIDER_NAMES),
		statusArbitrary,
		async (selected, status) => {
			const originalError = new Error(`${selected} failed during ${status}`);
			const selectedOverrides = status === "ineligible"
				? { eligibility: { eligible: false, reason: `${selected} missing` } }
				: status === "eligibility-failure"
					? { eligibilityError: originalError }
					: status === "search-failure" ? { error: originalError } : {};
			const fixture = createFixture({ [selected]: selectedOverrides });

			if (status === "success") {
				const result = await fixture.webSearch.search("query", { provider: selected });
				assert.equal(result.provider, selected);
			} else {
				await assert.rejects(fixture.webSearch.search("query", { provider: selected }), (error) => {
					if (status === "ineligible") assert.ok(error instanceof ProviderIneligibleError);
					else assert.equal(error, originalError);
					return true;
				});
			}

			for (const name of PROVIDER_NAMES) {
				assert.equal(fixture.providers[name].eligibilityChecks(), name === selected ? 1 : 0);
				assert.equal(
					fixture.providers[name].attempts(),
					name === selected && (status === "search-failure" || status === "success") ? 1 : 0,
				);
			}
		},
	), { numRuns: 60 });
});

test("property: auto follows the fixed model order at most once and stops after first success", async () => {
	const statusArbitrary = fc.constantFrom("ineligible", "eligibility-failure", "failure", "abort-failure", "success");
	await fc.assert(fc.asyncProperty(
		fc.array(statusArbitrary, { minLength: PROVIDER_NAMES.length, maxLength: PROVIDER_NAMES.length }),
		fc.constantFrom("default", "recency", "count"),
		async (statuses, policy) => {
			const errors = new Map();
			const overrides = {};
			for (let index = 0; index < PROVIDER_NAMES.length; index++) {
				const name = PROVIDER_NAMES[index];
				const status = statuses[index];
				if (status === "ineligible") {
					overrides[name] = { eligibility: { eligible: false, reason: `${name} missing` } };
				} else if (status === "eligibility-failure") {
					const error = new Error(`${name} eligibility failed`);
					errors.set(name, error);
					overrides[name] = { eligibilityError: error };
				} else if (status === "failure" || status === "abort-failure") {
					const error = status === "failure"
						? new Error(`${name} failed`)
						: new DOMException(`${name} timeout`, "AbortError");
					errors.set(name, error);
					overrides[name] = { error };
				}
			}

			const options = policy === "recency"
				? { provider: "auto", recencyFilter: "day" }
				: policy === "count" ? { provider: "auto", numResults: 3 } : { provider: "auto" };
			const modelOrder = policy === "default" ? PROVIDER_NAMES : PROVIDER_NAMES.slice(1);
			const expectedEligibility = [];
			const expectedCalls = [];
			let expectedSuccess;
			for (const name of modelOrder) {
				const status = statuses[PROVIDER_NAMES.indexOf(name)];
				expectedEligibility.push(name);
				if (status === "ineligible" || status === "eligibility-failure") continue;
				expectedCalls.push(name);
				if (status === "success") {
					expectedSuccess = name;
					break;
				}
			}

			const fixture = createFixture(overrides);
			if (expectedSuccess) {
				const result = await fixture.webSearch.search("query", options);
				assert.equal(result.provider, expectedSuccess);
			} else {
				await assert.rejects(fixture.webSearch.search("query", options), (error) => {
					const expectedFailures = expectedEligibility.filter((name) => errors.has(name));
					if (expectedFailures.length === 0) {
						assert.match(error.message, /^No search provider available\./);
					} else {
						assert.ok(error instanceof AutoSearchError);
						assert.deepEqual(error.failures.map((failure) => failure.provider), expectedFailures);
						for (let index = 0; index < expectedFailures.length; index++) {
							assert.equal(error.failures[index].error, errors.get(expectedFailures[index]));
						}
					}
					return true;
				});
			}

			assert.deepEqual(fixture.eligibilityLog, expectedEligibility);
			assert.deepEqual(fixture.callLog, expectedCalls);
			for (const name of PROVIDER_NAMES) {
				assert.equal(fixture.providers[name].eligibilityChecks(), expectedEligibility.includes(name) ? 1 : 0);
				assert.equal(fixture.providers[name].attempts(), expectedCalls.includes(name) ? 1 : 0);
			}
		},
	), { numRuns: 100 });
});

test("property: caller cancellation during eligibility or search stops at the cancelling provider", async () => {
	await fc.assert(fc.asyncProperty(
		fc.integer({ min: 0, max: PROVIDER_NAMES.length - 1 }),
		fc.constantFrom("eligibility", "search"),
		async (cancelIndex, cancelOperation) => {
			const controller = new AbortController();
			const reason = new Error(`cancel during ${cancelOperation} at ${cancelIndex}`);
			const overrides = {};
			for (let index = 0; index < PROVIDER_NAMES.length; index++) {
				const name = PROVIDER_NAMES[index];
				if (index === cancelIndex && cancelOperation === "eligibility") {
					overrides[name] = {
						eligibilityOperation: async () => {
							controller.abort(reason);
							throw new DOMException("cancelled", "AbortError");
						},
					};
				} else if (index === cancelIndex) {
					overrides[name] = {
						search: async () => {
							controller.abort(reason);
							throw new DOMException("cancelled", "AbortError");
						},
					};
				} else {
					overrides[name] = { error: new Error(`${name} failed`) };
				}
			}
			const fixture = createFixture(overrides);
			await assert.rejects(
				fixture.webSearch.search("query", { provider: "auto", signal: controller.signal }),
				(error) => error === reason,
			);
			assert.deepEqual(fixture.eligibilityLog, PROVIDER_NAMES.slice(0, cancelIndex + 1));
			assert.deepEqual(
				fixture.callLog,
				PROVIDER_NAMES.slice(0, cancelOperation === "search" ? cancelIndex + 1 : cancelIndex),
			);
		},
	), { numRuns: 40 });
});

test("property: eligibility reports generated reasons and never executes searches", async () => {
	await fc.assert(fc.asyncProperty(
		fc.array(fc.record({ eligible: fc.boolean(), reason: fc.string() }), {
			minLength: PROVIDER_NAMES.length,
			maxLength: PROVIDER_NAMES.length,
		}),
		fc.integer({ min: 1, max: 4 }),
		async (states, repetitions) => {
			const overrides = {};
			for (let index = 0; index < PROVIDER_NAMES.length; index++) {
				const state = states[index];
				overrides[PROVIDER_NAMES[index]] = {
					eligibility: state.eligible ? { eligible: true } : { eligible: false, reason: state.reason },
				};
			}
			const fixture = createFixture(overrides);
			for (let repetition = 0; repetition < repetitions; repetition++) {
				const eligibility = await fixture.webSearch.eligibility();
				for (let index = 0; index < PROVIDER_NAMES.length; index++) {
					const state = states[index];
					assert.deepEqual(
						eligibility[PROVIDER_NAMES[index]],
						state.eligible ? { eligible: true } : { eligible: false, reason: state.reason },
					);
				}
			}
			assert.deepEqual(fixture.callLog, []);
			for (const name of PROVIDER_NAMES) {
				assert.equal(fixture.providers[name].eligibilityChecks(), repetitions);
				assert.equal(fixture.providers[name].attempts(), 0);
			}
		},
	), { numRuns: 60 });
});
