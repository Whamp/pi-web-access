import { open } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";

/**
 * Makes directory-handle sync fail and returns a function that restores the original method.
 */
export async function failDirectorySync(probePath, options = {}) {
	const { code = "EIO", once = true } = options;
	const probe = await open(probePath, "r");
	const prototype = Object.getPrototypeOf(probe);
	const originalSync = prototype.sync;
	let failed = false;
	await probe.close();
	prototype.sync = async function () {
		if ((await this.stat()).isDirectory() && (!once || !failed)) {
			failed = true;
			throw Object.assign(new Error("directory sync failed"), { code });
		}
		return originalSync.call(this);
	};
	return () => {
		prototype.sync = originalSync;
	};
}

/**
 * Replaces selected node:fs promise methods and returns the patched object plus a restore function.
 */
export function replaceFsPromiseMethods(replacementFactories) {
	const require = createRequire(import.meta.url);
	const fsPromises = require("node:fs").promises;
	const originals = {};
	for (const [name, createReplacement] of Object.entries(replacementFactories)) {
		originals[name] = fsPromises[name];
		fsPromises[name] = createReplacement(fsPromises[name]);
	}
	syncBuiltinESMExports();
	return {
		fsPromises,
		restore() {
			for (const [name, original] of Object.entries(originals)) {
				fsPromises[name] = original;
			}
			syncBuiltinESMExports();
		},
	};
}
