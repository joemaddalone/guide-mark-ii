import { z } from "zod";
import {
	MAX_TRIALS,
	MAX_PHASE_TIMING_OVERHEAD_SECONDS,
	P95_MIN_TRIALS,
	PHASE_TIMING_TOLERANCE_SECONDS,
	RAM_MEASUREMENT_PROCESS_RSS,
	RAM_MEASUREMENT_SYSTEM_FALLBACK,
	THERMAL_STATE_ORDER,
} from "./constants";
import {
	DECODE_TIMING_CLIENT_STREAM,
	DECODE_TIMING_UNAVAILABLE,
} from "./stats";

// Type aliases
export type NonNegativeFloat = number;
export type NonNegativeInt = number;
export type PositiveFloat = number;
export type PositiveInt = number;
export type PercentFloat = number;
export type ProbabilityFloat = number;
export type TemperatureFloat = number;
export type TokenCountSource =
	| "usage.completion_tokens"
	| "word_fallback"
	| "mixed";
export type RAMMeasurementMethod = "process_rss" | "system_fallback";
export type InputTokenCountSource =
	| "unavailable"
	| "estimated"
	| "tokenizer"
	| "engine";
export type DecodeTimingSource = "unavailable" | "client_stream";
export type RequestMode = "streaming" | "non_streaming";
export type ConnectionMode = "per_request" | "persistent";
export type ThermalMonitorSource = "foundation" | "unavailable";
export type BenchmarkProfile = "baseline" | "sustained";
export type EngineName = string;

// Zod schemas for validation
const nonNegativeFloat = z.number().min(0);
const nonNegativeInt = z.number().int().min(0);
const positiveFloat = z.number().gt(0);
const positiveInt = z.number().int().gt(0);
const percentFloat = z.number().min(0).max(100);
const probabilityFloat = z.number().min(0).max(1);
const temperatureFloat = z.number().min(0).max(2);

export function normalizeModelQuantization(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/-/g, "")
		.replace(/_/g, "")
		.replace(/ /g, "");
	if (!normalized) {
		throw new Error("quantization must not be empty");
	}
	const aliases: Record<string, string> = {
		"4bits": "4bit",
		int4: "4bit",
		q4: "4bit",
		"8bits": "8bit",
		int8: "8bit",
		q8: "8bit",
		float16: "fp16",
		f16: "fp16",
		bfloat16: "bf16",
	};
	return aliases[normalized] ?? normalized;
}

export const HardwareSchema = z
	.object({
		chip: z.string().describe("Apple Silicon chip model (e.g. 'Apple M2')"),
		machine_model: z
			.string()
			.describe("Mac machine identifier (e.g. 'Mac14,2')"),
		memory_gb: nonNegativeFloat.describe("Unified memory in GB"),
		macos_version: z.string().describe("macOS version (e.g. '15.3.1')"),
		python_version: z.string().describe("Python version (e.g. '3.11.4')"),
		architecture: z.string().min(1).describe("CPU architecture (e.g. 'arm64')"),
		thermal_state: z
			.string()
			.default("unavailable_permission")
			.describe(
				"Thermal pressure level (nominal/fair/serious/critical or unavailable_*)",
			),
		power_source: z
			.string()
			.nullish()
			.describe(
				"macOS power source during hardware detection (ac_power/battery/unavailable_*)",
			),
		low_power_mode: z
			.string()
			.nullish()
			.describe(
				"macOS Low Power Mode state during hardware detection (on/off/unavailable_*)",
			),
	})
	.refine(
		(data) => {
			const ts = data.thermal_state;
			if (!ts) return true;
			if (
				["nominal", "fair", "serious", "critical"].includes(ts) ||
				(ts.startsWith("unavailable_") && /^[a-z0-9_]+$/.test(ts))
			) {
				return true;
			}
			if (ts === "unavailable_no_sudo") {
				data.thermal_state = "unavailable_permission";
				return true;
			}
			return false;
		},
		{
			message:
				"thermal_state must be nominal/fair/serious/critical or an unavailable_* status",
		},
	);

export const EngineSchema = z.object({
	name: z.string().trim().min(1).describe("Engine name"),
	version: z.string().min(1).describe("Engine version string"),
});

export const ModelSchema = z
	.object({
		name: z.string().describe("Model name (e.g. 'Qwen3.5-9B')"),
		quantization: z
			.string()
			.describe("Quantization format (e.g. '4bit', '8bit')"),
		format: z
			.string()
			.nullish()
			.describe(
				"Optional model weight/container format reported by the engine",
			),
	})
	.refine((data) => {
		data.name = data.name.trim();
		if (!data.name) throw new Error("model name must not be empty");
		data.quantization = normalizeModelQuantization(data.quantization);
		if (data.format) {
			data.format = data.format.trim() || null;
		}
		return true;
	});

export const TrialStatsSchema = z
	.object({
		mean: nonNegativeFloat.describe("Mean across trials"),
		stddev: nonNegativeFloat.describe("Standard deviation across trials"),
		min: nonNegativeFloat.describe("Minimum observed value"),
		max: nonNegativeFloat.describe("Maximum observed value"),
		p95: nonNegativeFloat
			.nullish()
			.describe(
				`Nearest-rank p95 when at least ${P95_MIN_TRIALS} trials are available`,
			),
	})
	.refine((data) => {
		if (data.min > data.max) {
			throw new Error("min must be less than or equal to max");
		}
		if (!(data.min <= data.mean && data.mean <= data.max)) {
			throw new Error("mean must be between min and max");
		}
		if (data.min === data.max && data.stddev !== 0) {
			throw new Error("stddev must be 0 when min and max are equal");
		}
		if (data.p95 != null && !(data.min <= data.p95 && data.p95 <= data.max)) {
			throw new Error("p95 must be between min and max");
		}
		return true;
	});

export const ThroughputProgressSampleSchema = z
	.object({
		completion_tokens: positiveInt.describe(
			"Generated completion tokens or estimated output words at sample time",
		),
		elapsed_seconds: positiveFloat.describe(
			"Client-observed elapsed seconds at sample time",
		),
		tokens_per_second: nonNegativeFloat.describe(
			"Cumulative completion tokens divided by elapsed seconds",
		),
		token_count_source: z
			.enum(["usage.completion_tokens", "word_fallback"])
			.describe("Token count source used for this progress sample"),
	})
	.refine((data) => {
		const expected =
			Math.round((data.completion_tokens / data.elapsed_seconds) * 100) / 100;
		if (Math.abs(data.tokens_per_second - expected) > 0.02) {
			throw new Error(
				"tokens_per_second must match completion_tokens / elapsed_seconds",
			);
		}
		return true;
	});

export const MetricsSchema = z
	.object({
		ttft_cold: TrialStatsSchema.describe("Time to first token, cold (seconds)"),
		ttft_cached: TrialStatsSchema.describe(
			"Time to first token, cached (seconds)",
		),
		tokens_per_second: TrialStatsSchema.describe(
			"Legacy throughput field: client-observed total request throughput (tok/s), including request overhead, prefill, and decode",
		),
		request_tokens_per_second: TrialStatsSchema.describe(
			"Client-observed total request throughput (tok/s), including request overhead, prefill, and decode. Current results mirror tokens_per_second here.",
		),
		decode_tokens_per_second: TrialStatsSchema.nullish().describe(
			"Decode-only throughput (tok/s) when reliable engine timing is available",
		),
		decode_timing_source: z
			.enum(["unavailable", "client_stream"])
			.default("unavailable")
			.describe("Source used for decode-only throughput timing"),
		ram_peak_gb: nonNegativeFloat.describe(
			"Legacy diagnostic peak RSS of the engine server process after warmup, or fallback system memory usage when the process cannot be located (GB)",
		),
		ram_is_process_rss: z
			.boolean()
			.describe(
				"True if diagnostic RAM was measured from process RSS, False if system fallback was used",
			),
		ram_measurement_method: z
			.enum(["process_rss", "system_fallback"])
			.describe("Measurement method used for diagnostic ram_peak_gb"),
		system_ram_peak_gb: nonNegativeFloat.describe(
			"Peak total Mac RAM in use during the benchmark (GB)",
		),
		system_ram_peak_percent: percentFloat.describe(
			"Peak total Mac RAM usage percentage during the benchmark",
		),
		token_count_source: z
			.enum(["usage.completion_tokens", "word_fallback", "mixed"])
			.describe("Source used to count generated tokens for throughput"),
	})
	.refine((data) => {
		const expected = data.ram_is_process_rss
			? RAM_MEASUREMENT_PROCESS_RSS
			: RAM_MEASUREMENT_SYSTEM_FALLBACK;
		if (data.ram_measurement_method !== expected) {
			throw new Error("ram_measurement_method must match ram_is_process_rss");
		}
		if (data.decode_tokens_per_second == null) {
			if (data.decode_timing_source !== DECODE_TIMING_UNAVAILABLE) {
				throw new Error(
					"decode_timing_source must be unavailable when decode throughput is missing",
				);
			}
		} else if (
			![DECODE_TIMING_CLIENT_STREAM].includes(data.decode_timing_source)
		) {
			throw new Error(
				"decode_timing_source must describe provided decode throughput",
			);
		}
		return true;
	});

export const TrialsSchema = z
	.object({
		count: z
			.number()
			.int()
			.min(1)
			.max(MAX_TRIALS)
			.describe("Number of trials run"),
		ttft_cold_raw: z
			.array(nonNegativeFloat)
			.describe("Raw cold TTFT values per trial"),
		ttft_cached_raw: z
			.array(nonNegativeFloat)
			.describe("Raw cached TTFT values per trial"),
		tokens_per_second_raw: z
			.array(nonNegativeFloat)
			.describe("Raw tok/s values per trial"),
		throughput_elapsed_seconds_raw: z
			.array(positiveFloat)
			.describe("Client-observed elapsed seconds for each throughput request"),
		decode_tokens_per_second_raw: z
			.array(nonNegativeFloat)
			.nullish()
			.describe(
				"Raw decode-only tok/s values per throughput trial when available",
			),
		decode_elapsed_seconds_raw: z
			.array(positiveFloat)
			.nullish()
			.describe(
				"Client-observed first-content-to-stream-end seconds for each decode throughput trial",
			),
		completion_tokens_raw: z
			.array(nonNegativeInt)
			.describe(
				"Generated completion token counts per throughput trial when available. For word_fallback results this is an estimated output word count.",
			),
		throughput_progress_samples_raw: z
			.array(z.array(ThroughputProgressSampleSchema))
			.nullish()
			.describe(
				"Per-throughput-trial progress samples for long sustained runs. Intermediate samples may use word_fallback estimates when streaming responses do not expose incremental usage tokens.",
			),
	})
	.refine((data) => {
		const lengths = new Set([
			data.ttft_cold_raw.length,
			data.ttft_cached_raw.length,
			data.tokens_per_second_raw.length,
			data.throughput_elapsed_seconds_raw.length,
			data.completion_tokens_raw.length,
		]);
		if (data.decode_tokens_per_second_raw != null) {
			lengths.add(data.decode_tokens_per_second_raw.length);
		}
		if (data.decode_elapsed_seconds_raw != null) {
			lengths.add(data.decode_elapsed_seconds_raw.length);
		}
		if (data.throughput_progress_samples_raw != null) {
			lengths.add(data.throughput_progress_samples_raw.length);
		}
		if (lengths.size !== 1 || !lengths.has(data.count)) {
			throw new Error("trials.count must match all raw metric list lengths");
		}
		if (
			data.decode_tokens_per_second_raw == null &&
			data.decode_elapsed_seconds_raw != null
		) {
			throw new Error(
				"decode_elapsed_seconds_raw requires decode_tokens_per_second_raw",
			);
		}
		return true;
	});

export const GenerationParametersSchema = z.object({
	temperature: temperatureFloat.describe(
		"Sampling temperature requested from the engine",
	),
	top_p: probabilityFloat.describe(
		"Nucleus sampling top_p requested from the engine",
	),
});

export const BenchmarkProtocolPhaseSchema = z
	.object({
		prompts: z
			.array(z.string())
			.min(1)
			.describe("Prompt text used by this benchmark phase"),
		requested_max_tokens: positiveInt.describe(
			"max_tokens requested from the engine for this phase",
		),
		requested_min_tokens: positiveInt
			.nullish()
			.describe(
				"min_tokens requested from the engine for this phase when used",
			),
		request_mode: z
			.enum(["streaming", "non_streaming"])
			.nullish()
			.describe("Whether this phase used streaming or non-streaming requests"),
		stream_usage_requested: z
			.boolean()
			.nullish()
			.describe(
				"Whether stream_options.include_usage was requested for this phase",
			),
		generation_parameters: GenerationParametersSchema.describe(
			"Generation sampling parameters requested for this phase",
		),
		input_tokens: z
			.array(nonNegativeInt)
			.nullish()
			.describe("Input token counts aligned with prompts when available"),
		input_token_count_source: z
			.enum(["unavailable", "estimated", "tokenizer", "engine"])
			.default("unavailable")
			.describe("How input token counts were obtained"),
	})
	.refine((data) => {
		if (data.prompts.some((p) => !p.trim())) {
			throw new Error("protocol prompts must not be empty");
		}
		if (
			data.requested_min_tokens != null &&
			data.requested_min_tokens > data.requested_max_tokens
		) {
			throw new Error("requested_min_tokens must be <= requested_max_tokens");
		}
		if (data.stream_usage_requested && data.request_mode !== "streaming") {
			throw new Error(
				"stream_usage_requested can only be true for streaming requests",
			);
		}
		if (data.input_tokens == null) {
			if (data.input_token_count_source !== "unavailable") {
				throw new Error(
					"input_token_count_source must be unavailable when input_tokens is missing",
				);
			}
		} else {
			if (data.input_tokens.length !== data.prompts.length) {
				throw new Error("input_tokens must match prompts length");
			}
			if (data.input_token_count_source === "unavailable") {
				throw new Error(
					"input_token_count_source must describe provided input_tokens",
				);
			}
		}
		return true;
	});

export const BenchmarkProtocolSchema = z.object({
	name: z.enum(["baseline", "sustained"]).describe("Benchmark protocol name"),
	version: z
		.string()
		.min(1)
		.describe("Internal benchmark protocol compatibility label"),
	warmup: BenchmarkProtocolPhaseSchema,
	ttft_cold: BenchmarkProtocolPhaseSchema,
	ttft_cached: BenchmarkProtocolPhaseSchema,
	throughput: BenchmarkProtocolPhaseSchema,
});

export const PhaseTimingsSchema = z
	.object({
		warmup: nonNegativeFloat.describe("Warmup phase duration in seconds"),
		ttft_cold: nonNegativeFloat.describe("Cold TTFT phase duration in seconds"),
		cache_priming: nonNegativeFloat.describe(
			"Cached TTFT priming duration in seconds",
		),
		ttft_cached: nonNegativeFloat.describe(
			"Cached TTFT phase duration in seconds",
		),
		throughput: nonNegativeFloat.describe(
			"Throughput phase duration in seconds",
		),
		total_runtime: nonNegativeFloat.describe(
			"Total measured benchmark runtime in seconds",
		),
	})
	.refine((data) => {
		const phaseSum =
			data.warmup +
			data.ttft_cold +
			data.cache_priming +
			data.ttft_cached +
			data.throughput;
		if (data.total_runtime + PHASE_TIMING_TOLERANCE_SECONDS < phaseSum) {
			throw new Error("total_runtime must cover the sum of benchmark phases");
		}
		if (
			data.total_runtime - phaseSum >
			MAX_PHASE_TIMING_OVERHEAD_SECONDS + PHASE_TIMING_TOLERANCE_SECONDS
		) {
			throw new Error(
				`total_runtime exceeds benchmark phase durations by more than ${MAX_PHASE_TIMING_OVERHEAD_SECONDS} seconds`,
			);
		}
		return true;
	});

export const ThermalMonitorSchema = z
	.object({
		sample_interval_seconds: positiveFloat.describe(
			"Seconds between thermal monitor samples",
		),
		source: z
			.enum(["foundation", "unavailable"])
			.describe("Source used for continuous thermal monitoring"),
		start_state: z.string().min(1).describe("First observed thermal state"),
		end_state: z.string().min(1).describe("Last observed thermal state"),
		worst_state: z.string().min(1).describe("Worst observed thermal state"),
		samples: nonNegativeInt.describe(
			"Number of valid thermal samples collected",
		),
		changed_during_run: z
			.boolean()
			.describe("Whether thermal state changed during the run"),
		non_nominal_observed: z
			.boolean()
			.describe("Whether a known non-nominal state was observed"),
		non_nominal_phases: z
			.array(z.string())
			.default([])
			.describe(
				"Benchmark phases where a known non-nominal state was observed",
			),
		sampling_errors: nonNegativeInt
			.default(0)
			.describe("Number of thermal monitor sampling errors during the run"),
	})
	.refine((data) => {
		if (
			!data.changed_during_run &&
			(data.start_state !== data.end_state ||
				data.worst_state !== data.start_state)
		) {
			throw new Error(
				"unchanged thermal monitor must have identical start, end, and worst states",
			);
		}
		const worstRank = THERMAL_STATE_ORDER[data.worst_state];
		for (const [label, state] of [
			["start_state", data.start_state],
			["end_state", data.end_state],
		] as const) {
			const stateRank = THERMAL_STATE_ORDER[state];
			if (
				stateRank !== undefined &&
				(worstRank === undefined || stateRank > worstRank)
			) {
				throw new Error(`worst_state must be at least as severe as ${label}`);
			}
		}
		const worstIsNonNominal =
			worstRank !== undefined && data.worst_state !== "nominal";
		if (data.non_nominal_observed !== worstIsNonNominal) {
			throw new Error(
				"non_nominal_observed must match the recorded worst_state",
			);
		}
		if (data.non_nominal_phases.length > 0 && !data.non_nominal_observed) {
			throw new Error(
				"non_nominal_observed must be true when non_nominal_phases is non-empty",
			);
		}
		if (data.non_nominal_phases.some((phase) => !phase.trim())) {
			throw new Error("non_nominal_phases must not contain blank phase names");
		}
		return true;
	});

export const MetaSchema = z.object({
	chronos_version: z.string().min(1).describe("mlx-chronos version used"),
	timestamp: z
		.string()
		.datetime({ offset: true })
		.describe("Timestamp of the benchmark run"),
	benchmark_profile: z
		.enum(["baseline", "sustained"])
		.describe("Benchmark profile selected for the run"),
	ram_sample_interval_seconds: positiveFloat.describe(
		"Seconds between diagnostic engine RSS and system RAM samples",
	),
	elapsed_since_last_benchmark_seconds: nonNegativeFloat
		.nullish()
		.describe(
			"Seconds since the latest prior result JSON in the same output directory",
		),
	cooldown_seconds: nonNegativeFloat
		.nullish()
		.describe("Requested cooldown delay before this run, if any"),
	benchmark_protocol: BenchmarkProtocolSchema.describe(
		"Prompt and token-bound metadata for reproducing the benchmark",
	),
	phase_timings_seconds: PhaseTimingsSchema.describe(
		"Elapsed time for each benchmark phase and the total run",
	),
	thermal_monitor: ThermalMonitorSchema.describe(
		"Continuous thermal sampling summary for this run",
	),
	warmup_failures: nonNegativeInt.describe(
		"Number of unrecorded warmup calls that failed before measurement",
	),
	system_ram_monitor_errors: nonNegativeInt
		.default(0)
		.describe("Number of system RAM sampling errors during the run"),
	engine_ram_monitor_errors: nonNegativeInt
		.default(0)
		.describe("Number of diagnostic engine RSS sampling errors during the run"),
	word_fallback_warning: z
		.boolean()
		.describe(
			"True when throughput token counts include word_fallback estimates",
		),
	engine_version_warning: z
		.boolean()
		.describe("True when engine.version is unknown"),
	sustained_throttling_warning: z
		.boolean()
		.describe(
			"True when a sustained run observes a late throughput drop while thermal state changed or became non-nominal",
		),
	cached_ttft_warning: z
		.boolean()
		.describe("True when cached TTFT is close to cold TTFT"),
});

export const BenchmarkResultSchema = z
	.object({
		hardware: HardwareSchema,
		engine: EngineSchema,
		model: ModelSchema,
		metrics: MetricsSchema,
		trials: TrialsSchema,
		meta: MetaSchema,
	})
	.refine((data) => {
		if (data.meta.benchmark_protocol.name !== data.meta.benchmark_profile) {
			throw new Error("benchmark_protocol.name must match benchmark_profile");
		}
		return true;
	});

export type Hardware = z.infer<typeof HardwareSchema>;
export type Engine = z.infer<typeof EngineSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type Metrics = z.infer<typeof MetricsSchema>;
export type Trials = z.infer<typeof TrialsSchema>;
export type Meta = z.infer<typeof MetaSchema>;
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;
