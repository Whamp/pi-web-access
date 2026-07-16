/** Structured metadata attached to a repository log message. */
export interface LogContext {
	readonly [key: string]: unknown;
}

/** Writes an informational diagnostic through the repository logging boundary. */
export function logInfo(message: string, context: LogContext = {}): void {
	console.info(message, context);
}

/** Writes a warning diagnostic through the repository logging boundary. */
export function logWarn(message: string, context: LogContext = {}): void {
	console.warn(message, context);
}

/** Writes an error diagnostic through the repository logging boundary. */
export function logError(message: string, context: LogContext = {}): void {
	console.error(message, context);
}

/** Writes an exception diagnostic through the repository logging boundary. */
export function logException(message: string, error: unknown, context: LogContext = {}): void {
	console.error(message, { ...context, error });
}
