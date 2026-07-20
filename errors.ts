/** Reports that a response body exceeded its configured byte limit. */
export class ResponseBodyTooLargeError extends Error {
	readonly limitBytes: number;
	readonly receivedBytes: number;

	constructor(limitBytes: number, receivedBytes: number) {
		super(`Response body exceeded the ${limitBytes}-byte limit`);
		this.name = "ResponseBodyTooLargeError";
		this.limitBytes = limitBytes;
		this.receivedBytes = receivedBytes;
	}
}

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
