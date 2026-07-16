/** Identifies a known Web Access configuration field that failed validation. */
export class WebAccessConfigurationError extends Error {
	readonly sourcePath: string;
	readonly key: string;

	constructor(sourcePath: string, key: string, expectation: string) {
		super(`Invalid Web Access configuration at ${sourcePath}: ${key} ${expectation}`);
		this.name = "WebAccessConfigurationError";
		this.sourcePath = sourcePath;
		this.key = key;
	}
}
