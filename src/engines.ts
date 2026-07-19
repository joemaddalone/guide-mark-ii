import {
	BENCHMARK_REQUEST_TEMPERATURE,
	BENCHMARK_REQUEST_TOP_P,
	ERROR_RESPONSE_BODY_LIMIT,
	TOKEN_COUNT_SOURCE_USAGE,
	TOKEN_COUNT_SOURCE_WORD_FALLBACK,
} from "./constants";
import {
	DECODE_TIMING_CLIENT_STREAM,
	DECODE_TIMING_UNAVAILABLE,
	type ThroughputMeasurement,
} from "./stats";
import { requestWithRetry } from "./httpRetry";

const THROUGHPUT_STREAM_TIMEOUT_SECONDS = 60.0;
const THROUGHPUT_TIMEOUT_SECONDS_PER_TOKEN = 0.5;

export class ResponseError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly responseText: string,
		public readonly headers: Record<string, string>,
	) {
		super(message);
		this.name = "ResponseError";
	}
}

export abstract class BaseEngine {
	abstract readonly name: string;
	abstract readonly defaultPort: number;

	protected port: number;

	constructor(port?: number) {
		this.port = port ?? 0;
	}

	baseUrl(): string {
		return `http://localhost:${this.port}/v1`;
	}

	rootUrl(): string {
		return `http://localhost:${this.port}`;
	}

	endpoint(): string {
		return "/chat/completions";
	}

	usesChatApi(): boolean {
		return true;
	}

	buildPayload(
		prompt: string,
		model: string,
		maxTokens: number,
		stream: boolean,
		minTokens?: number,
	): Record<string, unknown> {
		const payload: Record<string, unknown> = {
			model: this.requestModelName(model),
			max_tokens: maxTokens,
			stream,
			temperature: BENCHMARK_REQUEST_TEMPERATURE,
			top_p: BENCHMARK_REQUEST_TOP_P,
		};
		if (minTokens !== undefined) {
			payload.min_tokens = minTokens;
		}
		if (this.usesChatApi()) {
			payload.messages = [{ role: "user", content: prompt }];
		} else {
			payload.prompt = prompt;
		}
		return payload;
	}

	protected requestModelName(model: string): string {
		return model.trim() || "default";
	}

	protected requestBodyContext(
		action: string,
		url: string,
		model?: string,
		requestModel?: string,
	): string {
		const parts = [`engine=${this.name}`, `action=${action}`, `url=${url}`];
		if (model !== undefined) parts.push(`model=${JSON.stringify(model)}`);
		if (requestModel !== undefined)
			parts.push(`request_model=${JSON.stringify(requestModel)}`);
		return parts.join("; ");
	}

	protected async responseBodyExcerpt(
		response: Response | null,
	): Promise<string | null> {
		if (response === null) return null;
		try {
			const body = await response.text();
			const trimmed = body.trim();
			if (!trimmed) return null;
			const collapsed = trimmed.split(/\s+/).join(" ");
			if (collapsed.length > ERROR_RESPONSE_BODY_LIMIT) {
				return `${collapsed.slice(0, ERROR_RESPONSE_BODY_LIMIT)}...`;
			}
			return collapsed;
		} catch {
			return null;
		}
	}

	protected requestErrorMessage(
		action: string,
		url: string,
		error: Error,
		model?: string,
		requestModel?: string,
	): string {
		const context = this.requestBodyContext(action, url, model, requestModel);
		if (error instanceof ResponseError) {
			const details = [`status=${error.statusCode}`];
			if (error.responseText) {
				const truncated =
					error.responseText.length > ERROR_RESPONSE_BODY_LIMIT
						? `${error.responseText.slice(0, ERROR_RESPONSE_BODY_LIMIT)}...`
						: error.responseText;
				details.push(`response=${JSON.stringify(truncated)}`);
			}
			return `${context}; ${details.join("; ")}`;
		}
		return `${context}; error=${error.message}`;
	}

	protected invalidResponseMessage(
		action: string,
		url: string,
		reason: string,
		model?: string,
		requestModel?: string,
	): string {
		return `${this.requestBodyContext(action, url, model, requestModel)}; error=${reason}`;
	}

	async isServerRunning(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl()}/models`, {
				method: "GET",
				signal: AbortSignal.timeout(2000),
			});
			return response.status === 200;
		} catch {
			return false;
		}
	}

	getServerPid(): number | null {
		return null;
	}

	validateModelBackend(_model: string): Record<string, string> {
		return {};
	}

	protected streamChunkHasContent(chunk: Record<string, unknown>): boolean {
		const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(choices) || choices.length === 0) return false;
		const choice = choices[0];
		if (!choice) return false;
		const delta = (choice.delta ?? {}) as Record<string, unknown>;
		for (const key of ["content", "reasoning", "reasoning_content"]) {
			const value = delta[key];
			if (typeof value === "string" && value) return true;
		}
		if (delta.tool_calls) return true;
		const text = choice.text;
		if (typeof text === "string" && text) return true;
		return false;
	}

	protected extractStreamText(chunk: Record<string, unknown>): string {
		const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(choices) || choices.length === 0) return "";
		const choice = choices[0];
		if (!choice) return "";
		const delta = (choice.delta ?? {}) as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of ["content", "reasoning", "reasoning_content"]) {
			const value = delta[key];
			if (typeof value === "string" && value) parts.push(value);
		}
		const text = choice.text;
		if (typeof text === "string" && text) parts.push(text);
		return parts.join("");
	}

	protected extractStreamUsageTokens(
		chunk: Record<string, unknown>,
	): number | null {
		const usage = chunk.usage as Record<string, unknown> | undefined;
		if (!usage) return null;
		const tokens = usage.completion_tokens;
		if (typeof tokens === "number" && tokens > 0) return tokens;
		if (typeof tokens === "string" && Number(tokens) > 0) return Number(tokens);
		return null;
	}

	protected estimatedCompletionWords(textParts: string[]): number {
		return textParts.join("").split(/\s+/).filter(Boolean).length;
	}

	protected appendProgressSample(
		samples: Array<Record<string, unknown>>,
		completionTokens: number,
		elapsedSeconds: number,
		tokenCountSource: string,
	): void {
		if (completionTokens <= 0 || elapsedSeconds <= 0) return;
		const rounded = Math.round(elapsedSeconds * 1000) / 1000;
		if (rounded <= 0) return;
		const sample = {
			completion_tokens: completionTokens,
			elapsed_seconds: rounded,
			tokens_per_second: Math.round((completionTokens / rounded) * 100) / 100,
			token_count_source: tokenCountSource,
		};
		const last = samples[samples.length - 1];
		if (
			last &&
			(last as Record<string, unknown>).elapsed_seconds === rounded &&
			(last as Record<string, unknown>).token_count_source === tokenCountSource
		) {
			samples[samples.length - 1] = sample;
			return;
		}
		samples.push(sample);
	}

	protected versionFromMapping(
		mapping: Record<string, unknown>,
		versionKeys: readonly string[],
	): string | null {
		for (const key of versionKeys) {
			const value = mapping[key];
			if (typeof value === "string" || typeof value === "number") {
				const version = String(value).trim();
				if (version) return version;
			}
		}
		for (const nestedKey of ["metadata", "meta"]) {
			const nested = mapping[nestedKey];
			if (typeof nested === "object" && nested !== null) {
				const v = this.versionFromMapping(
					nested as Record<string, unknown>,
					versionKeys,
				);
				if (v) return v;
			}
		}
		return null;
	}

	async getVersionFromModelsEndpoint(
		versionKeys: readonly string[] = [
			"engine_version",
			"server_version",
			"version",
		],
	): Promise<string | null> {
		try {
			const response = await fetch(`${this.baseUrl()}/models`, {
				signal: AbortSignal.timeout(2000),
			});
			if (!response.ok) return null;
			const data = (await response.json()) as Record<string, unknown>;
			const version = this.versionFromMapping(data, versionKeys);
			if (version) return version;
			const items = data.data;
			if (Array.isArray(items)) {
				for (const item of items) {
					if (typeof item === "object" && item !== null) {
						const v = this.versionFromMapping(
							item as Record<string, unknown>,
							versionKeys,
						);
						if (v) return v;
					}
				}
			}
		} catch {
			// ignore
		}
		return null;
	}

	protected shouldRetryWithoutStreamUsage(error: Error): boolean {
		if (!(error instanceof ResponseError)) return false;
		if (error.statusCode !== 400 && error.statusCode !== 422) return false;
		const body = error.responseText.toLowerCase();
		return body.includes("stream_options") || body.includes("include_usage");
	}

	protected throughputTimeout(maxTokens: number): number {
		return Math.max(
			THROUGHPUT_STREAM_TIMEOUT_SECONDS,
			maxTokens * THROUGHPUT_TIMEOUT_SECONDS_PER_TOKEN,
		);
	}

	async measureTTFT(
		prompt: string,
		model: string = "default",
		client?: { fetch: typeof fetch },
	): Promise<number> {
		const payload = this.buildPayload(prompt, model, 1, true);
		const start = performance.now();
		const url = `${this.baseUrl()}${this.endpoint()}`;
		const requestModel = String(payload.model);
		const action = "measure TTFT";
		const fetchFn = client?.fetch ?? fetch;

		try {
			const response = await requestWithRetry(
				() =>
					fetchFn(url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload),
					}),
				{ action },
			);

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				const headers: Record<string, string> = {};
				response.headers.forEach((v, k) => {
					headers[k] = v;
				});
				throw new ResponseError(
					this.requestErrorMessage(
						action,
						url,
						new ResponseError(
							`HTTP ${response.status}`,
							response.status,
							body,
							headers,
						),
						model,
						requestModel,
					),
					response.status,
					body,
					headers,
				);
			}

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error(
					this.invalidResponseMessage(
						action,
						url,
						"no response body",
						model,
						requestModel,
					),
				);
			}

			try {
				const decoder = new TextDecoder();
				let buffer = "";
				let streamDone = false;
				const deadline = performance.now() + 30000;

				while (!streamDone) {
					if (performance.now() > deadline) {
						throw new Error(
							this.invalidResponseMessage(
								action,
								url,
								"stream read timed out",
								model,
								requestModel,
							),
						);
					}
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (!line.startsWith("data:")) continue;
						const data = line.slice(5).trim();
						if (!data || data === "[DONE]") {
							if (data === "[DONE]") streamDone = true;
							continue;
						}
						try {
							const chunk = JSON.parse(data) as Record<string, unknown>;
							if (this.streamChunkHasContent(chunk)) {
								return Math.round((performance.now() - start) * 1000) / 1000;
							}
						} catch {}
					}
				}

				throw new Error(
					this.invalidResponseMessage(
						action,
						url,
						"stream ended before a valid content token was received",
						model,
						requestModel,
					),
				);
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* already released */
				}
			}
		} catch (error) {
			if (error instanceof Error && !error.message.includes(action)) {
				throw new Error(
					this.requestErrorMessage(action, url, error, model, requestModel),
				);
			}
			throw error;
		}
	}

	async measureThroughput(
		prompt: string,
		model: string = "default",
		maxTokens: number = 100,
		minTokens?: number,
		progressSampleIntervalTokens?: number,
		requestStreamUsage: boolean = true,
		client?: { fetch: typeof fetch },
	): Promise<ThroughputMeasurement> {
		if (
			progressSampleIntervalTokens !== undefined &&
			progressSampleIntervalTokens <= 0
		) {
			throw new Error("progress_sample_interval_tokens must be greater than 0");
		}

		const basePayload = this.buildPayload(
			prompt,
			model,
			maxTokens,
			true,
			minTokens,
		);
		const url = `${this.baseUrl()}${this.endpoint()}`;
		const requestModel = String(basePayload.model);
		const action = "measure throughput";
		const usageAttempts = requestStreamUsage ? [true, false] : [false];
		const fetchFn = client?.fetch ?? fetch;

		let firstTokenAt: number | null = null;
		let streamFinishedAt: number | null = null;
		const completionTextParts: string[] = [];
		let completionTokens: number | null = null;
		const progressSamples: Array<Record<string, unknown>> = [];
		let nextProgressSampleAt = progressSampleIntervalTokens;
		let start = 0;

		for (const includeUsage of usageAttempts) {
			const payload = { ...basePayload } as Record<string, unknown>;
			if (includeUsage) {
				payload.stream_options = { include_usage: true };
			}

			start = performance.now();
			firstTokenAt = null;
			streamFinishedAt = null;
			completionTextParts.length = 0;
			completionTokens = null;
			progressSamples.length = 0;
			nextProgressSampleAt = progressSampleIntervalTokens;

			try {
				const response = await requestWithRetry(
					() =>
						fetchFn(url, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(payload),
						}),
					{ action },
				);

				if (!response.ok) {
					const errorBody = await response.text().catch(() => "");
					const headers: Record<string, string> = {};
					response.headers.forEach((v, k) => {
						headers[k] = v;
					});
					if (
						includeUsage &&
						this.shouldRetryWithoutStreamUsage(
							new ResponseError(
								`HTTP ${response.status}`,
								response.status,
								errorBody,
								headers,
							),
						)
					) {
						continue;
					}
					throw new ResponseError(
						this.requestErrorMessage(
							action,
							url,
							new ResponseError(
								`HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
								response.status,
								errorBody,
								headers,
							),
							model,
							requestModel,
						),
						response.status,
						errorBody,
						headers,
					);
				}

				const reader = response.body?.getReader();
				if (!reader)
					throw new Error(
						this.invalidResponseMessage(
							action,
							url,
							"no response body",
							model,
							requestModel,
						),
					);

				try {
					const decoder = new TextDecoder();
					let buffer = "";
					let streamDone = false;
					const deadline =
						performance.now() + this.throughputTimeout(maxTokens) * 1000;

					while (!streamDone) {
						if (performance.now() > deadline) {
							throw new Error(
								this.invalidResponseMessage(
									action,
									url,
									"stream read timed out",
									model,
									requestModel,
								),
							);
						}
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";

						for (const line of lines) {
							if (!line.startsWith("data:")) continue;
							const rawChunk = line.slice(5).trim();
							if (!rawChunk) continue;
							if (rawChunk === "[DONE]") {
								streamFinishedAt = performance.now();
								streamDone = true;
								break;
							}
							try {
								const chunk = JSON.parse(rawChunk) as Record<string, unknown>;
								if (typeof chunk !== "object" || chunk === null) continue;
								const usageTokens = this.extractStreamUsageTokens(chunk);
								if (usageTokens !== null) completionTokens = usageTokens;
								if (this.streamChunkHasContent(chunk)) {
									if (firstTokenAt === null) firstTokenAt = performance.now();
									const text = this.extractStreamText(chunk);
									if (text) {
										completionTextParts.push(text);
										if (nextProgressSampleAt !== undefined) {
											const est =
												this.estimatedCompletionWords(completionTextParts);
											while (est >= nextProgressSampleAt) {
												this.appendProgressSample(
													progressSamples,
													nextProgressSampleAt,
													(performance.now() - start) / 1000,
													TOKEN_COUNT_SOURCE_WORD_FALLBACK,
												);
												nextProgressSampleAt +=
													progressSampleIntervalTokens ?? 0;
											}
										}
									}
								}
							} catch {}
						}
					}
				} finally {
					try {
						reader.releaseLock();
					} catch {
						/* already released */
					}
				}
				break;
			} catch (error) {
				if (
					includeUsage &&
					error instanceof Error &&
					this.shouldRetryWithoutStreamUsage(error)
				) {
					continue;
				}
				throw error instanceof Error ? error : new Error(String(error));
			}
		}

		const elapsed =
			streamFinishedAt !== null
				? (streamFinishedAt - start) / 1000
				: (performance.now() - start) / 1000;
		let roundedElapsed = Math.round(Math.max(elapsed, 0.0) * 1000) / 1000;
		if (roundedElapsed <= 0) roundedElapsed = 0.001;

		if (firstTokenAt === null) {
			throw new Error(
				this.invalidResponseMessage(
					action,
					url,
					"stream ended before a valid content token was received",
					model,
					requestModel,
				),
			);
		}

		let tokenCountSource: string;
		if (completionTokens !== null) {
			tokenCountSource = TOKEN_COUNT_SOURCE_USAGE;
		} else {
			const text = completionTextParts.join("");
			completionTokens = Math.max(1, text.split(/\s+/).filter(Boolean).length);
			tokenCountSource = TOKEN_COUNT_SOURCE_WORD_FALLBACK;
		}

		const requestTps =
			Math.round((completionTokens / roundedElapsed) * 100) / 100;
		let decodeTps: number | null = null;
		let roundedDecodeElapsed: number | null = null;
		let decodeSource = DECODE_TIMING_UNAVAILABLE;

		const decodeElapsed = elapsed - (firstTokenAt - start) / 1000;
		if (
			tokenCountSource === TOKEN_COUNT_SOURCE_USAGE &&
			completionTokens > 1 &&
			decodeElapsed > 0
		) {
			roundedDecodeElapsed = Math.round(decodeElapsed * 1000) / 1000;
			if (roundedDecodeElapsed <= 0) roundedDecodeElapsed = 0.001;
			decodeTps =
				Math.round(((completionTokens - 1) / roundedDecodeElapsed) * 100) / 100;
			decodeSource = DECODE_TIMING_CLIENT_STREAM;
		}

		let finalizedProgressSamples: Array<Record<string, unknown>> = [];
		if (progressSampleIntervalTokens !== undefined) {
			finalizedProgressSamples = [...progressSamples];
			if (tokenCountSource === TOKEN_COUNT_SOURCE_USAGE) {
				finalizedProgressSamples = finalizedProgressSamples.filter(
					(s) => (s.completion_tokens as number) < (completionTokens ?? 0),
				);
			}
			const lastSample =
				finalizedProgressSamples[finalizedProgressSamples.length - 1];
			if (
				!lastSample ||
				(lastSample.completion_tokens as number) !== completionTokens
			) {
				this.appendProgressSample(
					finalizedProgressSamples,
					completionTokens ?? 0,
					Math.max(elapsed, 0.0),
					tokenCountSource,
				);
			}
		}

		return {
			request_tokens_per_second: requestTps,
			completion_tokens: completionTokens ?? 0,
			token_count_source: tokenCountSource,
			elapsed_seconds: roundedElapsed,
			decode_tokens_per_second: decodeTps,
			decode_elapsed_seconds: roundedDecodeElapsed,
			decode_timing_source: decodeSource,
			progress_samples: finalizedProgressSamples,
		};
	}

	async measureTokensPerSecond(
		prompt: string,
		model: string = "default",
		maxTokens: number = 100,
		minTokens?: number,
		requestStreamUsage: boolean = true,
		client?: { fetch: typeof fetch },
	): Promise<number> {
		const result = await this.measureThroughput(
			prompt,
			model,
			maxTokens,
			minTokens,
			undefined,
			requestStreamUsage,
			client,
		);
		return result.request_tokens_per_second;
	}

	abstract getVersion(): Promise<string>;
}

export class GenericEngine extends BaseEngine {
	override readonly name = "generic";
	override readonly defaultPort = 0;

	private _baseUrl: string;
	private _rootUrl: string;

	constructor(baseUrl?: string, port?: number) {
		super(port);
		if (baseUrl !== undefined) {
			const cleaned = baseUrl.replace(/\/$/, "");
			if (cleaned.endsWith("/v1")) {
				this._rootUrl = cleaned.slice(0, -3);
				this._baseUrl = cleaned;
			} else {
				this._rootUrl = cleaned;
				this._baseUrl = `${cleaned}/v1`;
			}
		} else {
			this._baseUrl = `http://localhost:${this.port}/v1`;
			this._rootUrl = `http://localhost:${this.port}`;
		}
	}

	override baseUrl(): string {
		return this._baseUrl;
	}

	override rootUrl(): string {
		return this._rootUrl;
	}

	override async isServerRunning(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl()}/models`, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});
			return response.status === 200;
		} catch {
			return false;
		}
	}

	async getVersion(): Promise<string> {
		const httpVersion = await this.getVersionFromModelsEndpoint();
		if (httpVersion) return httpVersion;
		return "unknown";
	}

	override validateModelBackend(_model: string): Record<string, string> {
		return {};
	}
}
