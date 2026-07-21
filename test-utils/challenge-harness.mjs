import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const lookupSource = `async () => [{ address: "93.184.216.34", family: 4 }]`;

export async function createHome(config = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-challenge-"));
	await mkdir(join(home, ".pi"), { recursive: true });
	await writeFile(join(home, ".pi", "web-search.json"), JSON.stringify(config));
	return home;
}

export function runChild(script, home, env = {}) {
	return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
		cwd: new URL("..", import.meta.url),
		encoding: "utf8",
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GEMINI_API_KEY: "",
			GOOGLE_GEMINI_BASE_URL: "",
			CLOUDFLARE_API_KEY: "",
			PARALLEL_API_KEY: "",
			...env,
		},
	});
}
