import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const moduleUrl = new URL("../abort.ts", import.meta.url).href;

test("a synchronous late disposer failure is observed", () => {
	const script = `
		import { settleWithAbort } from ${JSON.stringify(moduleUrl)};
		let resolveLate;
		const late = new Promise(resolve => { resolveLate = resolve; });
		const controller = new AbortController();
		let unhandled = false;
		process.on("unhandledRejection", () => { unhandled = true; });
		const result = settleWithAbort(() => late, controller.signal, () => {
			throw new Error("late disposer exploded");
		});
		controller.abort(new Error("cancel owner"));
		await result.catch(() => {});
		resolveLate("late value");
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		console.log(unhandled ? "unhandled" : "clean");
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "clean");
});
