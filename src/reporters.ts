import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function writeTextAtomic(outputPath: string, content: string): void {
	const dir = path.dirname(outputPath);
	const base = path.basename(outputPath);
	const tmpPath = path.join(dir, `.${base}.${Date.now()}.tmp`);
	try {
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, outputPath);
	} catch (err) {
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(tmpPath);
		} catch {
			// ignore cleanup errors
		}
		throw err;
	}
}

type StatStats = {
	mean: number;
	stddev: number;
	min: number;
	max: number;
	p95?: number;
};

type PhaseTimings = {
	warmup?: number;
	ttft_cold?: number;
	cache_priming?: number;
	ttft_cached?: number;
	throughput?: number;
	total_runtime?: number;
};

type ThermalMonitor = {
	source?: string;
	sample_interval_seconds?: number;
	start_state?: string;
	end_state?: string;
	worst_state?: string;
	samples?: number;
	changed_during_run?: boolean;
	non_nominal_phases?: string[];
	sampling_errors?: number;
};

type BenchmarkProtocol = {
	name?: string;
	version?: string;
	throughput?: {
		requested_max_tokens?: number;
		requested_min_tokens?: number | null;
	};
};

type BenchmarkMeta = {
	timestamp?: string | Date;
	chronos_version?: string;
	benchmark_profile?: string;
	benchmark_protocol?: BenchmarkProtocol;
	phase_timings_seconds?: PhaseTimings;
	thermal_monitor?: ThermalMonitor;
	warmup_failures?: number;
	system_ram_monitor_errors?: number;
	engine_ram_monitor_errors?: number;
	word_fallback_warning?: boolean;
	engine_version_warning?: boolean;
	sustained_throttling_warning?: boolean;
	cached_ttft_warning?: boolean;
	elapsed_since_last_benchmark_seconds?: number;
};

type BenchmarkHardware = {
	chip: string;
	machine_model?: string;
	memory_gb: number;
	macos_version: string;
	thermal_state?: string;
	power_source?: string;
	low_power_mode?: string;
};

type BenchmarkEngine = {
	name: string;
	version: string;
};

type BenchmarkModel = {
	name: string;
	quantization: string;
};

type BenchmarkMetrics = {
	tokens_per_second: StatStats;
	decode_tokens_per_second?: StatStats | null;
	decode_timing_source?: string;
	ttft_cold: StatStats;
	ttft_cached: StatStats;
	ram_peak_gb?: number;
	ram_is_process_rss?: boolean;
	ram_measurement_method?: string;
	system_ram_peak_gb?: number;
	system_ram_peak_percent?: number;
	token_count_source?: string;
};

type BenchmarkTrials = {
	count?: number;
	ttft_cold_raw?: number[];
	ttft_cached_raw?: number[];
	tokens_per_second_raw?: number[];
	throughput_elapsed_seconds_raw?: number[];
	decode_tokens_per_second_raw?: number[];
	completion_tokens_raw?: number[];
	throughput_progress_samples_raw?: {
		completion_tokens: number;
		elapsed_seconds: number;
		tokens_per_second: number;
		token_count_source: string;
	}[][];
};

export type BenchmarkResultDict = {
	hardware: BenchmarkHardware;
	engine: BenchmarkEngine;
	model: BenchmarkModel;
	metrics: BenchmarkMetrics;
	trials: BenchmarkTrials;
	meta: BenchmarkMeta;
};

export abstract class BaseReporter {
	abstract save(result: BenchmarkResultDict, resultsDir: string): string;

	protected _generateBaseFilename(result: BenchmarkResultDict): string {
		const chipSlug = this._slug(result.hardware.chip);
		const tsMeta = result.meta?.timestamp;
		let ts: string;
		if (typeof tsMeta === "string" && tsMeta) {
			try {
				const d = new Date(tsMeta.replace("Z", "+00:00"));
				ts = formatDate(d);
			} catch {
				ts = formatDate(new Date());
			}
		} else if (tsMeta instanceof Date) {
			ts = formatDate(tsMeta);
		} else {
			ts = formatDate(new Date());
		}
		const engineName = this._slug(result.engine.name);
		return `${engineName}_${chipSlug}_${ts}`;
	}

	protected _slug(value: string): string {
		return (
			value
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "_")
				.replace(/^_|_$/g, "") || "unknown"
		);
	}

	protected _formatTimestamp(value: unknown): string {
		if (value instanceof Date) {
			return value.toISOString().replace("+00:00", "Z");
		}
		if (typeof value === "string" && value.trim()) {
			return value;
		}
		return "unknown";
	}

	protected _formatOptional(value: unknown): unknown {
		return value == null ? "unknown" : value;
	}

	protected _formatStats(stats: StatStats, unit: string): string {
		let text = `${stats.mean} ${unit} (\u00b1${stats.stddev}; min ${stats.min}, max ${stats.max})`;
		if (stats.p95 != null) {
			text += `, p95 ${stats.p95} ${unit}`;
		}
		return text;
	}
}

function formatDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		`_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
	);
}

export class JSONReporter extends BaseReporter {
	save(result: BenchmarkResultDict, resultsDir: string): string {
		mkdirSync(resultsDir, { recursive: true });
		const filename = `${this._generateBaseFilename(result)}.json`;
		const outputPath = path.join(resultsDir, filename);
		writeTextAtomic(outputPath, `${JSON.stringify(result, null, 2)}\n`);
		return outputPath;
	}
}

export class MarkdownReporter extends BaseReporter {
	generate(result: BenchmarkResultDict): string {
		const hw = result.hardware;
		const metrics = result.metrics;
		const meta = result.meta ?? ({} as BenchmarkMeta);
		const trials = result.trials ?? ({} as BenchmarkTrials);

		let md = "# mlx-chronos Benchmark Result\n\n";
		md += `**Engine:** ${result.engine.name} (${result.engine.version})\n`;
		md += `**Model:** ${result.model.name} (${result.model.quantization})\n`;
		md += "\n";
		md += "## Run\n";
		md += `- **Timestamp:** ${this._formatTimestamp(meta.timestamp)}\n`;
		md += `- **Chronos version:** ${this._formatOptional(meta.chronos_version)}\n`;
		md += `- **Profile:** ${this._formatOptional(meta.benchmark_profile)}\n`;
		md += `- **Trials:** ${trials.count ?? "unknown"}\n`;
		md += `- **Token count source:** ${this._formatOptional(metrics.token_count_source)}\n`;
		const protocol = meta.benchmark_protocol ?? ({} as BenchmarkProtocol);
		if (protocol && Object.keys(protocol).length > 0) {
			md += `- **Protocol label:** ${this._formatOptional(protocol.name)} ${this._formatOptional(protocol.version)}\n`;
			const throughputProtocol =
				protocol.throughput ??
				({} as NonNullable<BenchmarkProtocol["throughput"]>);
			if (throughputProtocol && Object.keys(throughputProtocol).length > 0) {
				const minTokens = throughputProtocol.requested_min_tokens;
				const minTokensLabel = minTokens == null ? "none" : minTokens;
				md += `- **Throughput token bounds:** max ${throughputProtocol.requested_max_tokens ?? "unknown"}, min ${minTokensLabel}\n`;
			}
		}
		if (meta.word_fallback_warning) {
			md +=
				"- **Warning:** throughput token counts used word_fallback; local tok/s is an estimate and is not leaderboard-comparable.\n";
		}
		if (meta.engine_version_warning) {
			md +=
				"- **Warning:** engine version detection failed; `engine.version` is `unknown`.\n";
		}
		if (meta.sustained_throttling_warning) {
			md +=
				"- **Warning:** sustained profile observed late throughput degradation with a thermal-state signal.\n";
		}
		if (meta.cached_ttft_warning) {
			md +=
				"- **Warning:** cached TTFT is close to cold TTFT; prompt/KV cache reuse may not have occurred.\n";
		}
		if (meta.elapsed_since_last_benchmark_seconds != null) {
			md += `- **Elapsed since prior result:** ${meta.elapsed_since_last_benchmark_seconds} s\n`;
		}
		if (meta.warmup_failures) {
			md += `- **Warmup failures:** ${meta.warmup_failures}\n`;
		}
		const phaseTimings = meta.phase_timings_seconds;
		if (phaseTimings && phaseTimings.total_runtime != null) {
			md += `- **Total runtime:** ${phaseTimings.total_runtime} s\n`;
		}
		md += "\n";

		md += "## Hardware\n";
		md += `- **Chip:** ${hw.chip}\n`;
		md += `- **Machine:** ${this._formatOptional(hw.machine_model)}\n`;
		md += `- **Memory:** ${hw.memory_gb} GB\n`;
		md += `- **macOS:** ${hw.macos_version}\n`;
		md += `- **Thermal state:** ${this._formatOptional(hw.thermal_state)}\n`;
		if (hw.power_source != null) {
			md += `- **Power source:** ${this._formatOptional(hw.power_source)}\n`;
		}
		if (hw.low_power_mode != null) {
			md += `- **Low Power Mode:** ${this._formatOptional(hw.low_power_mode)}\n`;
		}
		md += "\n";

		md += "## Metrics\n";
		md += `- **Request throughput:** ${this._formatStats(metrics.tokens_per_second, "tokens/s")}\n`;
		const decodeStats = metrics.decode_tokens_per_second;
		if (decodeStats) {
			md += `- **Decode throughput:** ${this._formatStats(decodeStats, "tokens/s")}\n`;
		}
		md += `- **Decode timing source:** ${this._formatOptional(metrics.decode_timing_source)}\n`;
		md += `- **Cold TTFT:** ${this._formatStats(metrics.ttft_cold, "s")}\n`;
		md += `- **Cached TTFT:** ${this._formatStats(metrics.ttft_cached, "s")}\n`;
		const ramPeakGb = this._formatOptional(metrics.ram_peak_gb);
		const systemRamPeakGb = this._formatOptional(metrics.system_ram_peak_gb);
		const systemRamPeakPercent = this._formatOptional(
			metrics.system_ram_peak_percent,
		);

		if (metrics.ram_is_process_rss) {
			md += `- **Post-warmup engine RSS diagnostic:** ${ramPeakGb} GB\n`;
		} else {
			md += `- **Post-warmup engine RSS diagnostic fallback (system RAM):** ${ramPeakGb} GB\n`;
		}
		md += `- **RAM measurement method:** ${this._formatOptional(metrics.ram_measurement_method)}\n`;
		md += `- **Peak system RAM:** ${systemRamPeakGb} GB (${systemRamPeakPercent}%)\n`;

		const thermalMonitor = meta.thermal_monitor;
		if (thermalMonitor) {
			md += "\n## Thermal Monitor\n";
			md += `- **Source:** ${this._formatOptional(thermalMonitor.source)}\n`;
			md += `- **Sample interval:** ${thermalMonitor.sample_interval_seconds} s\n`;
			md += `- **State:** ${thermalMonitor.start_state} -> ${thermalMonitor.end_state} (worst: ${thermalMonitor.worst_state})\n`;
			md += `- **Samples:** ${thermalMonitor.samples}\n`;
			md += `- **Changed during run:** ${thermalMonitor.changed_during_run}\n`;
			const phases = thermalMonitor.non_nominal_phases ?? [];
			if (phases.length > 0) {
				md += `- **Non-nominal phases:** ${phases.join(", ")}\n`;
			}
		}

		if (phaseTimings) {
			const timingLines: string[] = [];
			for (const [label, key] of [
				["Warmup", "warmup"],
				["Cold TTFT", "ttft_cold"],
				["Cache priming", "cache_priming"],
				["Cached TTFT", "ttft_cached"],
				["Throughput", "throughput"],
			] as const) {
				const value = phaseTimings[key];
				if (value != null) {
					timingLines.push(`- **${label}:** ${value} s\n`);
				}
			}
			if (timingLines.length > 0) {
				md += "\n## Phase Timings\n";
				md += timingLines.join("");
			}
		}

		const rawPairs: [string, number[] | undefined | null][] = [
			["Cold TTFT", trials.ttft_cold_raw],
			["Cached TTFT", trials.ttft_cached_raw],
			["Request throughput", trials.tokens_per_second_raw],
			["Throughput elapsed seconds", trials.throughput_elapsed_seconds_raw],
			["Decode throughput", trials.decode_tokens_per_second_raw],
			["Completion tokens", trials.completion_tokens_raw],
		];
		const rawSections: [string, number[]][] = [];
		for (const pair of rawPairs) {
			const [label, values] = pair;
			if (values != null && values.length > 0) {
				rawSections.push([label, values]);
			}
		}
		if (rawSections.length > 0) {
			md += "\n## Raw Trials\n";
			for (const [label, values] of rawSections) {
				const renderedValues = values.map((v) => formatNumber(v)).join(", ");
				md += `- **${label}:** ${renderedValues}\n`;
			}
		}

		const progressSamples = trials.throughput_progress_samples_raw;
		if (progressSamples && progressSamples.length > 0) {
			md += "\n## Throughput Progress Samples\n";
			for (let index = 0; index < progressSamples.length; index++) {
				const samples = progressSamples[index];
				if (!samples || samples.length === 0) continue;
				const renderedSamples = samples
					.map(
						(sample) =>
							`${sample.completion_tokens} tokens @ ${sample.elapsed_seconds}s = ${sample.tokens_per_second} tokens/s (${sample.token_count_source})`,
					)
					.join(", ");
				md += `- **Trial ${index + 1}:** ${renderedSamples}\n`;
			}
		}

		return md;
	}

	save(result: BenchmarkResultDict, resultsDir: string): string {
		mkdirSync(resultsDir, { recursive: true });
		const filename = `${this._generateBaseFilename(result)}.md`;
		const outputPath = path.join(resultsDir, filename);
		const md = this.generate(result);
		writeTextAtomic(outputPath, md);
		return outputPath;
	}
}

function formatNumber(value: number): string {
	if (Number.isInteger(value)) return value.toString();
	const s = value.toPrecision(6);
	return s.replace(/\.?0+$/, "");
}
