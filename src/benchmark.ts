import {
	CACHED_TTFT_PROMPT,
	COLD_PROMPTS,
	CONNECTION_MODE_PERSISTENT,
	DEFAULT_RAM_SAMPLE_INTERVAL,
	DEFAULT_THERMAL_SAMPLE_INTERVAL,
	DEFAULT_THROUGHPUT_MAX_TOKENS,
	MAX_TRIALS,
	RAM_MEASUREMENT_PROCESS_RSS,
	RAM_MEASUREMENT_SYSTEM_FALLBACK,
	THROUGHPUT_PROMPTS,
	TOKEN_COUNT_SOURCE_MIXED,
	TOKEN_COUNT_SOURCE_USAGE,
	TOKEN_COUNT_SOURCE_WORD_FALLBACK,
	VALID_CONNECTION_MODES,
	WARMUP_MAX_TOKENS,
	WARMUP_PROMPT,
	buildBenchmarkProtocol,
} from "./constants";
import { detectHardware, getBenchmarkConditionWarnings } from "./detect";
import { GenericEngine, type BaseEngine } from "./engines";
import {
	DECODE_TIMING_CLIENT_STREAM,
	DECODE_TIMING_UNAVAILABLE,
	type ThroughputMeasurement,
	computeStats,
} from "./stats";
import {
	BenchmarkResultSchema,
	normalizeModelQuantization,
	normalizeModelReferenceUrl,
	type BenchmarkProfile,
} from "./schema";
import type { BenchmarkResultDict } from "./reporters";
import { RAMTracker, SystemRAMTracker, ThermalStateTracker } from "./trackers";

const VERSION = "0.1.0";

export const DEFAULT_TRIALS = 5;
const VALID_BENCHMARK_PROFILE_VALUES: readonly BenchmarkProfile[] = [
	"baseline",
	"sustained",
];
export const VALID_BENCHMARK_PROFILES = new Set<string>(
	VALID_BENCHMARK_PROFILE_VALUES,
);
export const BENCHMARK_PROFILE_BASELINE = "baseline";
export const BENCHMARK_PROFILE_SUSTAINED = "sustained";

const SUSTAINED_THROTTLING_DROP_RATIO = 0.85;
const SUSTAINED_THROTTLING_MIN_INTERVALS = 4;
const SUSTAINED_THROTTLING_EDGE_INTERVALS = 2;
const CACHED_TTFT_WARNING_RATIO = 0.8;
const CACHED_TTFT_WARNING_RATIO_ENV = "MLX_CHRONOS_CACHED_TTFT_RATIO";

type ThermalSummary = {
	sample_interval_seconds: number;
	source: string;
	start_state: string;
	end_state: string;
	worst_state: string;
	samples: number;
	changed_during_run: boolean;
	non_nominal_observed: boolean;
	non_nominal_phases: string[];
	sampling_errors: number;
};

function cachedTtftWarningRatio(): number {
	const rawRatio = process.env[CACHED_TTFT_WARNING_RATIO_ENV];
	if (rawRatio === undefined) return CACHED_TTFT_WARNING_RATIO;
	const ratio = parseFloat(rawRatio);
	if (Number.isNaN(ratio)) {
		console.warn(
			`Invalid ${CACHED_TTFT_WARNING_RATIO_ENV}=${rawRatio}; using default ${CACHED_TTFT_WARNING_RATIO}.`,
		);
		return CACHED_TTFT_WARNING_RATIO;
	}
	if (ratio > 0 && ratio <= 1) return ratio;
	console.warn(
		`Invalid ${CACHED_TTFT_WARNING_RATIO_ENV}=${rawRatio}; expected a number in (0, 1]; using default ${CACHED_TTFT_WARNING_RATIO}.`,
	);
	return CACHED_TTFT_WARNING_RATIO;
}

function normalizeTokenCountSource(source: unknown): string {
	const validTrialSources = new Set([
		TOKEN_COUNT_SOURCE_USAGE,
		TOKEN_COUNT_SOURCE_WORD_FALLBACK,
	]);
	if (typeof source === "string" && validTrialSources.has(source)) {
		return source;
	}
	throw new Error(
		`engine did not report a valid token count source after throughput measurement; expected one of ${[...validTrialSources].sort()}, got ${String(source)}`,
	);
}

function normalizeCompletionTokens(tokens: unknown): number {
	if (typeof tokens === "number" && tokens >= 0 && Number.isInteger(tokens)) {
		return tokens;
	}
	throw new Error(
		`engine did not report a valid completion token count after throughput measurement; expected non-negative int, got ${String(tokens)}`,
	);
}

function summarizeTokenCountSources(sources: string[]): string {
	const uniqueSources = new Set(sources);
	if (uniqueSources.size === 1 && uniqueSources.has(TOKEN_COUNT_SOURCE_USAGE)) {
		return TOKEN_COUNT_SOURCE_USAGE;
	}
	if (
		uniqueSources.size === 1 &&
		uniqueSources.has(TOKEN_COUNT_SOURCE_WORD_FALLBACK)
	) {
		return TOKEN_COUNT_SOURCE_WORD_FALLBACK;
	}
	return TOKEN_COUNT_SOURCE_MIXED;
}

function validateTokenBounds(
	tokens: number,
	source: string,
	minTokens: number | null | undefined,
	maxTokens: number,
): void {
	if (source !== TOKEN_COUNT_SOURCE_USAGE) return;
	if (tokens > maxTokens) {
		throw new Error(
			`throughput completion token count exceeded requested max_tokens; requested <= ${maxTokens}, got ${tokens}`,
		);
	}
	if (minTokens !== null && minTokens !== undefined && tokens < minTokens) {
		throw new Error(
			`throughput completion token count was below requested min_tokens; requested >= ${minTokens}, got ${tokens}`,
		);
	}
}

function validateThroughputMeasurement(value: unknown): ThroughputMeasurement {
	if (
		typeof value === "object" &&
		value !== null &&
		"request_tokens_per_second" in value
	) {
		return value as ThroughputMeasurement;
	}
	throw new Error(
		`engine returned an invalid throughput measurement; expected ThroughputMeasurement, got ${typeof value}`,
	);
}

async function recordPhase<T>(
	phaseTimings: Record<string, number>,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	const start = performance.now() / 1000;
	try {
		return await fn();
	} finally {
		phaseTimings[name] =
			Math.round((performance.now() / 1000 - start) * 1000) / 1000;
	}
}

async function sampleCurrentSystemRam(): Promise<[number, number]> {
	try {
		const [memsizeProc, vmPagesizeProc] = await Promise.all([
			Bun.spawn(["sysctl", "-n", "hw.memsize"], {
				stdout: "pipe",
				stderr: "pipe",
			}),
			Bun.spawn(["sysctl", "-n", "hw.vm_pagesize"], {
				stdout: "pipe",
				stderr: "pipe",
			}),
		]);

		const [memsizeOutput, pageSizeOutput] = await Promise.all([
			memsizeProc.stdout.text(),
			vmPagesizeProc.stdout.text(),
		]);

		const totalBytes = parseInt(memsizeOutput.trim(), 10);
		const pageSize = parseInt(pageSizeOutput.trim(), 10);

		if (Number.isNaN(totalBytes) || Number.isNaN(pageSize)) {
			return [0.0, 0.0];
		}

		const vmStat = Bun.spawn(["vm_stat"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const vmStatOutput = await vmStat.stdout.text();

		let activePages = 0;
		let wiredPages = 0;
		for (const line of vmStatOutput.split("\n")) {
			if (line.includes("Pages active:")) {
				const match = line.match(/(\d+)/);
				if (match?.[1]) activePages = parseInt(match[1], 10);
			}
			if (line.includes("Pages wired down:")) {
				const match = line.match(/(\d+)/);
				if (match?.[1]) wiredPages = parseInt(match[1], 10);
			}
		}

		const usedBytes = (activePages + wiredPages) * pageSize;
		const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0.0;
		return [usedBytes / 1024 ** 3, percent];
	} catch {
		return [0.0, 0.0];
	}
}

function unavailableThermalSummary(): ThermalSummary {
	return {
		sample_interval_seconds: DEFAULT_THERMAL_SAMPLE_INTERVAL,
		source: "unavailable",
		start_state: "unavailable_tracker_error",
		end_state: "unavailable_tracker_error",
		worst_state: "unavailable_tracker_error",
		samples: 1,
		changed_during_run: false,
		non_nominal_observed: false,
		non_nominal_phases: [],
		sampling_errors: 0,
	};
}

function logThermalMonitorWarnings(summary: ThermalSummary): void {
	const source = summary.source;
	if (source === "unavailable") {
		console.warn(
			"  Warning: thermal monitoring unavailable during run; " +
				"continuous thermal context is missing.",
		);
		return;
	}

	if (summary.changed_during_run) {
		console.warn(
			`  Warning: thermal state changed during run (${summary.start_state} -> ${summary.end_state}).`,
		);
	}
	if (summary.non_nominal_observed) {
		const phases =
			summary.non_nominal_phases.length > 0
				? summary.non_nominal_phases.join(", ")
				: "unknown";
		console.warn(
			`  Warning: non-nominal thermal state observed during benchmark (worst=${summary.worst_state}; phases=${phases}).`,
		);
	}
}

function throughputIntervalRates(
	samples: ReadonlyArray<Record<string, unknown>>,
): number[] {
	const rates: number[] = [];
	let previousTokens = 0;
	let previousElapsed = 0.0;
	let previousSource: string | null = null;

	for (const sample of samples) {
		const tokens = sample.completion_tokens;
		const elapsed = sample.elapsed_seconds;
		const source = sample.token_count_source;

		if (
			typeof tokens !== "number" ||
			!Number.isInteger(tokens) ||
			(typeof elapsed !== "number" && typeof elapsed !== "string")
		) {
			continue;
		}

		const tokenDelta = tokens - previousTokens;
		const elapsedDelta = Number(elapsed) - previousElapsed;
		const sameSource = source === previousSource || previousSource === null;

		if (tokenDelta > 0 && elapsedDelta > 0 && sameSource) {
			rates.push(tokenDelta / elapsedDelta);
		}

		previousTokens = tokens;
		previousElapsed = Number(elapsed);
		previousSource = typeof source === "string" ? source : null;
	}

	return rates;
}

function edgeAverage(values: number[], fromEnd: boolean = false): number {
	const window = Math.min(
		SUSTAINED_THROTTLING_EDGE_INTERVALS,
		Math.floor(values.length / 2),
	);
	if (window <= 0) return 0.0;
	const selected = fromEnd ? values.slice(-window) : values.slice(0, window);
	return selected.reduce((a, b) => a + b, 0) / selected.length;
}

function detectSustainedThrottling(
	progressSamplesTrials: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
	thermalSummary: ThermalSummary | null,
): boolean {
	if (!thermalSummary) return false;

	const thermalSignal =
		thermalSummary.changed_during_run || thermalSummary.non_nominal_observed;
	if (!thermalSignal) return false;

	for (const samples of progressSamplesTrials) {
		const rates = throughputIntervalRates(samples);
		if (rates.length < SUSTAINED_THROTTLING_MIN_INTERVALS) continue;
		const earlyRate = edgeAverage(rates);
		const lateRate = edgeAverage(rates, true);
		if (
			earlyRate > 0 &&
			lateRate <= earlyRate * SUSTAINED_THROTTLING_DROP_RATIO
		) {
			return true;
		}
	}
	return false;
}

export interface RunBenchmarkOptions {
	baseUrl: string;
	engineName?: string;
	modelName?: string;
	modelQuantization?: string;
	modelReferenceUrl?: string | null;
	trials?: number;
	notes?: string | null;
	ramSampleInterval?: number;
	throughputMaxTokens?: number;
	throughputMinTokens?: number | null;
	benchmarkProfile?: string;
	elapsedSinceLastBenchmarkSeconds?: number | null;
	cooldownSeconds?: number | null;
	progressSampleIntervalTokens?: number | null;
	connectionMode?: string;
}

export async function runBenchmark(
	options: RunBenchmarkOptions,
): Promise<BenchmarkResultDict> {
	const {
		baseUrl,
		engineName = "generic",
		modelName = "",
		modelQuantization: modelQuantizationInput = "4bit",
		modelReferenceUrl: modelReferenceUrlInput = null,
		trials = DEFAULT_TRIALS,
		notes = null,
		ramSampleInterval = DEFAULT_RAM_SAMPLE_INTERVAL,
		throughputMaxTokens = DEFAULT_THROUGHPUT_MAX_TOKENS,
		throughputMinTokens = null,
		benchmarkProfile = BENCHMARK_PROFILE_BASELINE,
		elapsedSinceLastBenchmarkSeconds = null,
		cooldownSeconds = null,
		progressSampleIntervalTokens = null,
		connectionMode = CONNECTION_MODE_PERSISTENT,
	} = options;

	let modelQuantization = modelQuantizationInput;

	if (!VALID_BENCHMARK_PROFILES.has(benchmarkProfile)) {
		throw new Error(
			`benchmark_profile must be one of ${[...VALID_BENCHMARK_PROFILES].sort().join(", ")}`,
		);
	}
	if (trials > MAX_TRIALS) {
		throw new Error(
			`Max trials is ${MAX_TRIALS} (one unique cold prompt per trial). Requested: ${trials}`,
		);
	}
	if (trials < 1) {
		throw new Error("trials must be at least 1");
	}
	if (ramSampleInterval <= 0) {
		throw new Error("ram_sample_interval must be greater than 0");
	}
	if (throughputMaxTokens < 1) {
		throw new Error("throughput_max_tokens must be at least 1");
	}
	if (throughputMinTokens !== null && throughputMinTokens < 1) {
		throw new Error("throughput_min_tokens must be at least 1 when set");
	}
	if (
		throughputMinTokens !== null &&
		throughputMinTokens > throughputMaxTokens
	) {
		throw new Error("throughput_min_tokens must be <= throughput_max_tokens");
	}
	if (
		elapsedSinceLastBenchmarkSeconds !== null &&
		elapsedSinceLastBenchmarkSeconds < 0
	) {
		throw new Error(
			"elapsed_since_last_benchmark_seconds must be non-negative",
		);
	}
	if (cooldownSeconds !== null && cooldownSeconds < 0) {
		throw new Error("cooldown_seconds must be non-negative");
	}
	if (
		progressSampleIntervalTokens !== null &&
		progressSampleIntervalTokens < 1
	) {
		throw new Error("progress_sample_interval_tokens must be at least 1");
	}
	if (!VALID_CONNECTION_MODES.has(connectionMode)) {
		throw new Error(
			`connection_mode must be one of ${[...VALID_CONNECTION_MODES].sort().join(", ")}`,
		);
	}

	const trimmedModelName = modelName.trim();
	if (!trimmedModelName) {
		throw new Error("model name must not be empty");
	}
	const modelReferenceUrl = normalizeModelReferenceUrl(modelReferenceUrlInput);

	if (trials < 3) {
		console.warn(
			`  Warning: only ${trials} trial(s) requested; stddev is low-confidence ` +
				"and will be 0.0 for a single trial.",
		);
	}

	console.log(`\n${"=".repeat(50)}`);
	console.log("  mlx-Chronos Benchmark");
	console.log(`  Engine : ${engineName}`);
	console.log(`  Model  : ${trimmedModelName} (${modelQuantization})`);
	console.log(`  Profile: ${benchmarkProfile}`);
	console.log(`  Trials : ${trials}`);
	console.log(`  HTTP   : ${connectionMode}`);
	const tokenRange =
		throughputMinTokens !== null
			? `${throughputMinTokens}-${throughputMaxTokens}`
			: `<= ${throughputMaxTokens}`;
	console.log(`  Output : throughput tokens ${tokenRange}`);
	console.log(`${"=".repeat(50)}\n`);

	// 1. Detect hardware
	console.log("Detecting hardware...");
	const hw = await detectHardware();
	console.log(`  ${hw.chip} — ${hw.memory_gb}GB — macOS ${hw.macos_version}\n`);
	const conditionWarnings = await getBenchmarkConditionWarnings(
		hw as unknown as Record<string, unknown>,
	);
	for (const warning of conditionWarnings) {
		console.warn(`  Warning: ${warning.label}: ${warning.detail}`);
	}
	if (conditionWarnings.length > 0) {
		console.log("");
	}

	// 2. Get engine
	const engine: BaseEngine = new GenericEngine(baseUrl);
	if (!(await engine.isServerRunning())) {
		throw new Error(
			`Server is not reachable at ${engine.baseUrl()}. ` +
				"Please start the engine server before running mlx-chronos.",
		);
	}

	const modelBackendMetadata = engine.validateModelBackend(trimmedModelName);
	const modelFormat = modelBackendMetadata.format;
	if (modelFormat) {
		console.log(`Model format: ${modelFormat}\n`);
	}
	const reportedQuantization = modelBackendMetadata.quantization;
	if (reportedQuantization) {
		const declaredQuantization = normalizeModelQuantization(modelQuantization);
		const authoritativeQuantization =
			normalizeModelQuantization(reportedQuantization);
		if (declaredQuantization !== authoritativeQuantization) {
			throw new Error(
				`declared model quantization does not match the engine metadata: declared ${JSON.stringify(modelQuantization)}, engine reported ${JSON.stringify(reportedQuantization)}`,
			);
		}
		modelQuantization = authoritativeQuantization;
	}

	// 3. Engine version
	const engineVersion = await engine.getVersion();
	console.log(`Engine version: ${engineVersion}\n`);
	const engineVersionWarning = engineVersion === "unknown";
	if (engineVersionWarning) {
		console.warn(
			"  Warning: engine version could not be detected; " +
				"engine.version will be saved as 'unknown'.",
		);
		console.warn(
			"  Engine versions affect comparability. Try restarting the engine " +
				"server or updating the engine CLI if this persists.\n",
		);
	}

	// 4. Start background sampling before warmup so load/cache pressure is captured.
	const phaseTimings: Record<string, number> = {};
	const totalRuntimeStart = performance.now() / 1000;

	console.log(
		`Starting continuous background thermal sampling (${DEFAULT_THERMAL_SAMPLE_INTERVAL.toFixed(3)}s interval)...`,
	);
	const thermalTracker = new ThermalStateTracker(
		DEFAULT_THERMAL_SAMPLE_INTERVAL,
		async () =>
			(await import("./detect").then((m) =>
				m.getThermalStateFromFoundation(),
			)) ?? "unavailable_foundation",
	);
	await thermalTracker.start();

	console.log(
		`Starting continuous background system RAM sampling (${ramSampleInterval.toFixed(3)}s interval)...`,
	);
	const systemRamTracker = new SystemRAMTracker(ramSampleInterval);
	await systemRamTracker.start();

	// 5. Run warmup and trials
	const ttftColdTrials: number[] = [];
	const ttftCachedTrials: number[] = [];
	const tpsTrials: number[] = [];
	const throughputElapsedTrials: number[] = [];
	const decodeTpsTrials: number[] = [];
	const decodeElapsedTrials: number[] = [];
	const decodeTimingSources: string[] = [];
	const tokenCountSources: string[] = [];
	const completionTokensTrials: number[] = [];
	const throughputProgressSamplesTrials: Array<Array<Record<string, unknown>>> =
		[];
	const warmupCalls = 2;
	let warmupFailures = 0;

	let peakRamGb: number | null = null;
	let systemRamPeakGb = 0;
	let systemRamPeakPercent = 0;
	let thermalSummary: ThermalSummary | null = null;
	let ramTracker: RAMTracker | null = null;
	let ramIsProcessRss = false;

	try {
		if (connectionMode === CONNECTION_MODE_PERSISTENT) {
			console.log("Using one persistent HTTP client for benchmark requests.");
		}

		// Warmup phase — 2 calls with the throughput prompt, not recorded
		await thermalTracker.setPhase("warmup");
		await recordPhase(phaseTimings, "warmup", async () => {
			console.log("Warming up (2 calls, not recorded)...");
			for (let i = 0; i < warmupCalls; i++) {
				try {
					await engine.measureTokensPerSecond(
						WARMUP_PROMPT,
						trimmedModelName,
						WARMUP_MAX_TOKENS,
						undefined,
						false,
						connectionMode === CONNECTION_MODE_PERSISTENT
							? { fetch }
							: undefined,
					);
				} catch (exc) {
					warmupFailures++;
					console.warn(`  Warmup call failed and was skipped: ${exc}`);
				}
			}
			if (warmupFailures === warmupCalls) {
				throw new Error(
					"all warmup calls failed; benchmark did not reach a warmed state",
				);
			}
			console.log("  Done.\n");
		});

		console.log(
			`Starting diagnostic post-warmup engine RAM sampling (${ramSampleInterval.toFixed(3)}s interval)...`,
		);
		// Diagnostic engine RAM intentionally starts after warmup, while system
		// RAM started before warmup to include model loading and cache pressure.
		const targetPid = engine.getServerPid();
		if (targetPid === null) {
			console.warn(
				"Engine PID not found; diagnostic engine RAM will use system RAM peak fallback.",
			);
		} else {
			try {
				ramTracker = new RAMTracker(ramSampleInterval, targetPid);
				await ramTracker.start();
				ramIsProcessRss = true;
			} catch (exc) {
				console.warn(
					`Could not start diagnostic engine RAM sampling for PID ${targetPid}: ${exc}`,
				);
				ramTracker = null;
			}
		}

		await thermalTracker.setPhase("ttft_cold");
		await recordPhase(phaseTimings, "ttft_cold", async () => {
			console.log("Running cold TTFT trials...");
			for (let i = 0; i < trials; i++) {
				const coldPrompt = COLD_PROMPTS[i] ?? "";
				console.log(`  Cold trial ${i + 1}/${trials} (unique prompt)...`);
				ttftColdTrials.push(
					await engine.measureTTFT(
						coldPrompt,
						trimmedModelName,
						connectionMode === CONNECTION_MODE_PERSISTENT
							? { fetch }
							: undefined,
					),
				);
			}
		});

		await thermalTracker.setPhase("cache_priming");
		await recordPhase(phaseTimings, "cache_priming", async () => {
			console.log("\nPriming cache for cached TTFT measurement...");
			try {
				await engine.measureTTFT(
					CACHED_TTFT_PROMPT,
					trimmedModelName,
					connectionMode === CONNECTION_MODE_PERSISTENT ? { fetch } : undefined,
				);
			} catch (exc) {
				throw new Error(
					`cache priming failed; cached TTFT cannot be measured reliably: ${exc}`,
				);
			}
			console.log("  Done.\n");
		});

		await thermalTracker.setPhase("ttft_cached");
		await recordPhase(phaseTimings, "ttft_cached", async () => {
			console.log("Running cached TTFT trials...");
			for (let i = 0; i < trials; i++) {
				console.log(`  Cached trial ${i + 1}/${trials} (fixed prompt)...`);
				ttftCachedTrials.push(
					await engine.measureTTFT(
						CACHED_TTFT_PROMPT,
						trimmedModelName,
						connectionMode === CONNECTION_MODE_PERSISTENT
							? { fetch }
							: undefined,
					),
				);
			}
		});

		await thermalTracker.setPhase("throughput");
		await recordPhase(phaseTimings, "throughput", async () => {
			console.log("\nRunning throughput trials...");
			for (let i = 0; i < trials; i++) {
				const throughputPrompt = THROUGHPUT_PROMPTS[i] ?? "";
				console.log(`  Throughput trial ${i + 1}/${trials}...`);
				const measurement = validateThroughputMeasurement(
					await engine.measureThroughput(
						throughputPrompt,
						trimmedModelName,
						throughputMaxTokens,
						throughputMinTokens ?? undefined,
						progressSampleIntervalTokens ?? undefined,
						true,
						connectionMode === CONNECTION_MODE_PERSISTENT
							? { fetch }
							: undefined,
					),
				);
				tpsTrials.push(measurement.request_tokens_per_second);
				throughputElapsedTrials.push(measurement.elapsed_seconds);
				const tokenSource = normalizeTokenCountSource(
					measurement.token_count_source,
				);
				const completionTokens = normalizeCompletionTokens(
					measurement.completion_tokens,
				);
				validateTokenBounds(
					completionTokens,
					tokenSource,
					throughputMinTokens,
					throughputMaxTokens,
				);
				tokenCountSources.push(tokenSource);
				completionTokensTrials.push(completionTokens);
				throughputProgressSamplesTrials.push([
					...measurement.progress_samples,
				] as Array<Record<string, unknown>>);
				if (measurement.decode_tokens_per_second !== null) {
					if (measurement.decode_elapsed_seconds === null) {
						throw new Error(
							"engine returned decode throughput without decode elapsed time",
						);
					}
					decodeTpsTrials.push(measurement.decode_tokens_per_second);
					decodeElapsedTrials.push(measurement.decode_elapsed_seconds);
					decodeTimingSources.push(measurement.decode_timing_source);
				}
			}
		});
	} finally {
		await thermalTracker.setPhase("teardown");

		if (ramTracker) {
			try {
				peakRamGb = await ramTracker.stop();
				console.log(
					`Diagnostic engine RAM sampling finished. Peak detected: ${peakRamGb.toFixed(2)} GB`,
				);
			} catch (exc) {
				console.warn(
					`Diagnostic engine RAM sampling failed during teardown: ${exc}`,
				);
				peakRamGb = null;
				ramIsProcessRss = false;
			}
		} else {
			ramIsProcessRss = false;
		}

		try {
			[systemRamPeakGb, systemRamPeakPercent] = await systemRamTracker.stop();
		} catch (exc) {
			console.warn(
				"System RAM sampling failed during teardown; using current system RAM snapshot as fallback: " +
					exc,
			);
			[systemRamPeakGb, systemRamPeakPercent] = await sampleCurrentSystemRam();
		}
		console.log(
			`System RAM sampling finished. Peak detected: ${systemRamPeakGb.toFixed(2)} GB (${systemRamPeakPercent.toFixed(1)}%)\n`,
		);

		try {
			thermalSummary = (await thermalTracker.stop()) as ThermalSummary;
		} catch (exc) {
			console.warn(
				`Thermal sampling failed during teardown; recording unavailable thermal summary: ${exc}`,
			);
			thermalSummary = unavailableThermalSummary();
		}

		phaseTimings.total_runtime =
			Math.round((performance.now() / 1000 - totalRuntimeStart) * 1000) / 1000;

		console.log(
			`Thermal sampling finished. Start: ${thermalSummary.start_state}; end: ${thermalSummary.end_state}; worst: ${thermalSummary.worst_state}\n`,
		);
		logThermalMonitorWarnings(thermalSummary);

		if (peakRamGb === null) {
			peakRamGb = systemRamPeakGb;
		}
	}

	console.log("");

	// 6. Compute statistics
	const ttftColdStats = computeStats(ttftColdTrials);
	const ttftCachedStats = computeStats(ttftCachedTrials);
	const tpsStats = computeStats(tpsTrials);

	const cachedTtftWarning =
		ttftColdStats.mean > 0 &&
		ttftCachedStats.mean >= ttftColdStats.mean * cachedTtftWarningRatio();
	if (cachedTtftWarning) {
		console.warn(
			"  Warning: cached TTFT is close to cold TTFT. The engine may not " +
				"have reused a prompt/KV cache for this run.",
		);
	}

	const tokenCountSource = summarizeTokenCountSources(tokenCountSources);
	const wordFallbackWarning =
		tokenCountSource === TOKEN_COUNT_SOURCE_WORD_FALLBACK ||
		tokenCountSource === TOKEN_COUNT_SOURCE_MIXED;
	if (wordFallbackWarning) {
		console.warn(
			"  Warning: throughput token counts used word_fallback for at least " +
				"one trial. Local tok/s results are estimates and are not " +
				"leaderboard-comparable.",
		);
		console.warn(
			"  Use an engine/server that returns usage.completion_tokens in the " +
				"streaming response for comparable results.",
		);
	}

	const sustainedThrottlingWarning =
		benchmarkProfile === BENCHMARK_PROFILE_SUSTAINED &&
		detectSustainedThrottling(throughputProgressSamplesTrials, thermalSummary);
	if (sustainedThrottlingWarning) {
		console.warn(
			"  Warning: sustained profile observed a late-run throughput drop " +
				"while thermal state changed or became non-nominal.",
		);
	}

	let decodeTpsStats: ReturnType<typeof computeStats> | null = null;
	let decodeTimingSource = DECODE_TIMING_UNAVAILABLE;
	if (
		decodeTpsTrials.length > 0 &&
		decodeTpsTrials.length === tpsTrials.length
	) {
		const uniqueDecodeSources = new Set(decodeTimingSources);
		if (
			uniqueDecodeSources.size === 1 &&
			uniqueDecodeSources.has(DECODE_TIMING_CLIENT_STREAM)
		) {
			decodeTpsStats = computeStats(decodeTpsTrials);
			decodeTimingSource =
				[...uniqueDecodeSources][0] ?? DECODE_TIMING_UNAVAILABLE;
		} else {
			console.warn(
				"Decode throughput sources were mixed or unavailable; " +
					"decode_tokens_per_second will be omitted.",
			);
		}
	} else if (decodeTpsTrials.length > 0) {
		console.warn(
			"Decode throughput was available for only some throughput trials; " +
				"decode_tokens_per_second will be omitted.",
		);
	}

	// 7. Build result
	const modelMetadata: Record<string, unknown> = {
		name: trimmedModelName,
		quantization: modelQuantization,
		reference_url: modelReferenceUrl,
	};
	if (modelFormat) {
		modelMetadata.format = modelFormat;
	}

	const systemRamTrackerStats = systemRamTracker.getStats();
	const engineRamMonitorErrors =
		ramTracker !== null ? ramTracker.getStats().sampleErrors : 0;

	const result = {
		hardware: hw,
		engine: {
			name: engineName,
			version: engineVersion,
		},
		model: modelMetadata,
		metrics: {
			ttft_cold: ttftColdStats,
			ttft_cached: ttftCachedStats,
			tokens_per_second: tpsStats,
			request_tokens_per_second: tpsStats,
			decode_tokens_per_second: decodeTpsStats,
			decode_timing_source: decodeTimingSource,
			ram_peak_gb: Math.round(peakRamGb * 1000) / 1000,
			ram_is_process_rss: ramIsProcessRss,
			ram_measurement_method: ramIsProcessRss
				? RAM_MEASUREMENT_PROCESS_RSS
				: RAM_MEASUREMENT_SYSTEM_FALLBACK,
			system_ram_peak_gb: Math.round(systemRamPeakGb * 1000) / 1000,
			system_ram_peak_percent: Math.round(systemRamPeakPercent * 10) / 10,
			token_count_source: tokenCountSource,
		},
		trials: {
			count: trials,
			ttft_cold_raw: ttftColdTrials,
			ttft_cached_raw: ttftCachedTrials,
			tokens_per_second_raw: tpsTrials,
			throughput_elapsed_seconds_raw: throughputElapsedTrials,
			decode_tokens_per_second_raw:
				decodeTpsTrials.length === tpsTrials.length ? decodeTpsTrials : null,
			decode_elapsed_seconds_raw:
				decodeElapsedTrials.length === tpsTrials.length
					? decodeElapsedTrials
					: null,
			completion_tokens_raw: completionTokensTrials,
			throughput_progress_samples_raw: throughputProgressSamplesTrials.some(
				(s) => s.length > 0,
			)
				? throughputProgressSamplesTrials
				: null,
		},
		meta: {
			chronos_version: VERSION,
			timestamp: new Date().toISOString(),
			benchmark_profile: benchmarkProfile,
			ram_sample_interval_seconds: ramSampleInterval,
			elapsed_since_last_benchmark_seconds:
				elapsedSinceLastBenchmarkSeconds !== null
					? Math.round(elapsedSinceLastBenchmarkSeconds * 1000) / 1000
					: null,
			cooldown_seconds: cooldownSeconds,
			phase_timings_seconds: phaseTimings,
			thermal_monitor: thermalSummary,
			warmup_failures: warmupFailures,
			system_ram_monitor_errors: systemRamTrackerStats.sampleErrors,
			engine_ram_monitor_errors: engineRamMonitorErrors,
			word_fallback_warning: wordFallbackWarning,
			engine_version_warning: engineVersionWarning,
			sustained_throttling_warning: sustainedThrottlingWarning,
			cached_ttft_warning: cachedTtftWarning,
			benchmark_protocol: buildBenchmarkProtocol(
				trials,
				throughputMaxTokens,
				throughputMinTokens,
				benchmarkProfile,
				connectionMode,
				false,
			),
			notes: notes,
		},
	};

	return BenchmarkResultSchema.parse(result) as BenchmarkResultDict;
}
