import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const hostPackages = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

test("Pi host packages are optional peers available during development", () => {
	for (const packageName of hostPackages) {
		assert.equal(packageJson.dependencies[packageName], undefined);
		assert.equal(packageJson.peerDependencies[packageName], "*");
		assert.deepEqual(packageJson.peerDependenciesMeta[packageName], { optional: true });
		assert.ok(packageJson.devDependencies[packageName], `${packageName} must be available for development`);
	}
});
