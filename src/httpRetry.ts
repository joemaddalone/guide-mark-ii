export const DEFAULT_HTTP_RETRY_ATTEMPTS = 3;
export const DEFAULT_HTTP_RETRY_BACKOFF_SECONDS = 0.25;
export const DEFAULT_HTTP_RETRY_MAX_BACKOFF_SECONDS = 8.0;

export class HttpError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly url: string,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export function isTransientHttpError(error: unknown): boolean {
	if (error instanceof HttpError) {
		return error.status >= 500 || error.status === 429;
	}
	if (error instanceof TypeError) {
		return (
			error.message.includes("fetch") ||
			error.message.includes("network") ||
			error.message.includes("timeout")
		);
	}
	return false;
}

function validateRetrySettings(
	attempts: number,
	backoffSeconds: number,
	maxBackoffSeconds: number,
): void {
	if (attempts < 1) {
		throw new Error("attempts must be at least 1");
	}
	if (backoffSeconds < 0) {
		throw new Error("backoff_seconds must be non-negative");
	}
	if (maxBackoffSeconds < 0) {
		throw new Error("max_backoff_seconds must be non-negative");
	}
}

function retryDelay(
	backoffSeconds: number,
	maxBackoffSeconds: number,
	attempt: number,
): number {
	let delay = Math.min(backoffSeconds, maxBackoffSeconds);
	for (let i = 0; i < Math.max(0, attempt - 1); i++) {
		if (delay >= maxBackoffSeconds) break;
		delay = Math.min(delay * 2, maxBackoffSeconds);
	}
	return delay;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function requestWithRetry<T>(
	call: () => Promise<T>,
	options: {
		action: string;
		attempts?: number;
		backoffSeconds?: number;
		maxBackoffSeconds?: number;
		logger?: { warn: (msg: string) => void };
	},
): Promise<T> {
	const {
		action,
		attempts = DEFAULT_HTTP_RETRY_ATTEMPTS,
		backoffSeconds = DEFAULT_HTTP_RETRY_BACKOFF_SECONDS,
		maxBackoffSeconds = DEFAULT_HTTP_RETRY_MAX_BACKOFF_SECONDS,
		logger,
	} = options;

	validateRetrySettings(attempts, backoffSeconds, maxBackoffSeconds);

	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await call();
		} catch (error) {
			if (!isTransientHttpError(error) || attempt === attempts) {
				throw error;
			}
			if (logger) {
				logger.warn(
					`${action} failed with transient HTTP error (${error}); retrying ${attempt + 1}/${attempts}.`,
				);
			}
			await sleep(retryDelay(backoffSeconds, maxBackoffSeconds, attempt));
		}
	}

	throw new Error("unreachable HTTP retry state");
}

export interface StreamContext<T> {
	open: () => Promise<T>;
	close: () => void;
}

export interface StreamResult<T> {
	response: StreamContext<T>;
	close: () => void;
}

export async function streamWithRetry<T>(
	openStream: () => Promise<StreamContext<T>>,
	options: {
		action: string;
		attempts?: number;
		backoffSeconds?: number;
		maxBackoffSeconds?: number;
		logger?: { warn: (msg: string) => void };
	},
): Promise<StreamResult<T>> {
	const {
		action,
		attempts = DEFAULT_HTTP_RETRY_ATTEMPTS,
		backoffSeconds = DEFAULT_HTTP_RETRY_BACKOFF_SECONDS,
		maxBackoffSeconds = DEFAULT_HTTP_RETRY_MAX_BACKOFF_SECONDS,
		logger,
	} = options;

	validateRetrySettings(attempts, backoffSeconds, maxBackoffSeconds);

	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const ctx = await openStream();
			return {
				response: ctx,
				close: () => ctx.close(),
			};
		} catch (error) {
			lastError = error;
			if (!isTransientHttpError(error) || attempt === attempts) {
				throw error;
			}
			if (logger) {
				logger.warn(
					`${action} failed with transient HTTP error (${error}); retrying ${attempt + 1}/${attempts}.`,
				);
			}
			await sleep(retryDelay(backoffSeconds, maxBackoffSeconds, attempt));
		}
	}

	throw lastError ?? new Error("unreachable HTTP stream retry state");
}
