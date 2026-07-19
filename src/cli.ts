import { Command } from "commander";
import { readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { globSync } from "glob";
import {
	runBenchmark,
	DEFAULT_TRIALS,
	BENCHMARK_PROFILE_BASELINE,
	BENCHMARK_PROFILE_SUSTAINED,
} from "./benchmark";
import {
	DEFAULT_RAM_SAMPLE_INTERVAL,
	DEFAULT_THROUGHPUT_MAX_TOKENS,
	MAX_TRIALS,
	RECENT_BENCHMARK_WARNING_SECONDS,
	SUSTAINED_PROGRESS_SAMPLE_INTERVAL_TOKENS,
	SUSTAINED_THROUGHPUT_MAX_TOKENS,
	SUSTAINED_TRIALS,
} from "./constants";
import {
	JSONReporter,
	MarkdownReporter,
	type BenchmarkResultDict,
} from "./reporters";

const VERSION = "0.1.0";

function parseTimestamp(value: unknown): Date | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const parsed = new Date(value.replace("Z", "+00:00"));
		if (Number.isNaN(parsed.getTime())) return null;
		return parsed;
	} catch {
		return null;
	}
}

function resultTimestamp(filePath: string): Date | null {
	let data: Record<string, unknown> | null = null;
	try {
		data = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		data = null;
	}
	if (data && typeof data === "object") {
		const meta = data.meta as Record<string, unknown> | undefined;
		const timestamp = parseTimestamp(meta?.timestamp);
		if (timestamp !== null) return timestamp;
	}
	try {
		return new Date(statSync(filePath).mtime);
	} catch {
		return null;
	}
}

function latestResultTimestamp(resultsDir: string): Date | null {
	if (!existsSync(resultsDir)) return null;
	const files = globSync("*.json", { cwd: resultsDir });
	const timestamps: Date[] = [];
	for (const file of files) {
		const ts = resultTimestamp(join(resultsDir, file));
		if (ts !== null) timestamps.push(ts);
	}
	if (timestamps.length === 0) return null;
	return timestamps.reduce((a, b) => (a > b ? a : b));
}

function elapsedSinceLastResult(resultsDir: string): number | null {
	const latest = latestResultTimestamp(resultsDir);
	if (latest === null) return null;
	const now = new Date();
	const elapsed = (now.getTime() - latest.getTime()) / 1000;
	return Math.max(0, elapsed);
}

function resolveProfileDefaults(options: {
	profile?: string;
	trials?: number;
	maxTokens?: number;
}): { profile: string; trials: number; maxTokens: number } {
	const profile = options.profile ?? BENCHMARK_PROFILE_BASELINE;
	const defaultTrials =
		profile === BENCHMARK_PROFILE_SUSTAINED ? SUSTAINED_TRIALS : DEFAULT_TRIALS;
	const defaultMaxTokens =
		profile === BENCHMARK_PROFILE_SUSTAINED
			? SUSTAINED_THROUGHPUT_MAX_TOKENS
			: DEFAULT_THROUGHPUT_MAX_TOKENS;
	return {
		profile,
		trials: options.trials ?? defaultTrials,
		maxTokens: options.maxTokens ?? defaultMaxTokens,
	};
}

function emitResultWarnings(result: BenchmarkResultDict): void {
	const meta = result.meta;
	if (meta.word_fallback_warning) {
		console.error(
			"Warning: throughput used word_fallback token counts. Local tok/s is an estimate.",
		);
	}
	if (meta.engine_version_warning) {
		console.error(
			"Warning: engine.version is 'unknown'. Engine versions affect comparability; try restarting the engine server or updating the engine CLI if detection keeps failing.",
		);
	}
	if (meta.sustained_throttling_warning) {
		console.error(
			"Warning: sustained profile observed a late throughput drop while thermal state changed or became non-nominal.",
		);
	}
}

function resultWarningLabels(result: BenchmarkResultDict): string[] {
	const meta = result.meta;
	const hardware = result.hardware;
	const labels: string[] = [];

	const warningFields: [string, string][] = [
		["word_fallback_warning", "estimated token counts"],
		["engine_version_warning", "unknown engine version"],
		["sustained_throttling_warning", "possible sustained throttling"],
		["cached_ttft_warning", "cached TTFT close to cold TTFT"],
	];
	for (const [field, label] of warningFields) {
		if (meta[field as keyof typeof meta]) labels.push(label);
	}
	if (meta.warmup_failures && meta.warmup_failures > 0)
		labels.push("warmup failures");

	const thermalMonitor = meta.thermal_monitor;
	if (thermalMonitor?.sampling_errors && thermalMonitor.sampling_errors > 0)
		labels.push("thermal monitor errors");

	const worstThermalState = thermalMonitor?.worst_state;
	if (String(worstThermalState ?? "").startsWith("unavailable")) {
		labels.push("thermal state unavailable");
	} else if (worstThermalState && worstThermalState !== "nominal") {
		labels.push(`thermal state ${worstThermalState}`);
	}

	if (hardware.power_source === "battery") labels.push("battery power");
	if (hardware.low_power_mode === "on") labels.push("Low Power Mode");

	// System RAM monitor errors
	if (meta.system_ram_monitor_errors && meta.system_ram_monitor_errors > 0) {
		labels.push("system RAM monitor errors");
	}

	// Engine RAM monitor errors
	if (meta.engine_ram_monitor_errors && meta.engine_ram_monitor_errors > 0) {
		labels.push("engine RAM monitor errors");
	}

	return labels;
}

function logResultSummary(result: BenchmarkResultDict): void {
	const metrics = result.metrics;
	const meta = result.meta;
	const thermal = meta.thermal_monitor;
	const throughput = metrics.tokens_per_second;
	const cold = metrics.ttft_cold;
	const cached = metrics.ttft_cached;
	const warnings = resultWarningLabels(result);

	console.log(`\n${"=".repeat(50)}`);
	console.log("  Results Summary");
	console.log(
		`  Throughput : ${(throughput.mean ?? 0).toFixed(2)} tok/s (±${(throughput.stddev ?? 0).toFixed(2)})`,
	);
	console.log(
		`  TTFT       : cold ${(cold.mean ?? 0).toFixed(3)}s | cached ${(cached.mean ?? 0).toFixed(3)}s`,
	);
	console.log(
		`  Thermal    : ${thermal?.start_state ?? "N/A"} -> ${thermal?.end_state ?? "N/A"} (worst: ${thermal?.worst_state ?? "N/A"})`,
	);
	console.log(
		`  Peak RAM   : ${((metrics.system_ram_peak_gb as number) ?? 0).toFixed(2)} GB (${((metrics.system_ram_peak_percent as number) ?? 0).toFixed(1)}%)`,
	);
	console.log(
		`  Warnings   : ${warnings.length > 0 ? warnings.join(", ") : "none"}`,
	);
	console.log(`${"=".repeat(50)}\n`);
}

async function cmdRun(options: {
	url: string;
	engine?: string;
	model: string;
	trials?: number;
	profile?: string;
	ramSampleInterval?: number;
	maxTokens?: number;
	minTokens?: number;
	format?: string;
	cooldownSeconds?: number;
	outputDir?: string;
}): Promise<void> {
	const { profile, trials, maxTokens } = resolveProfileDefaults({
		profile: options.profile,
		trials: options.trials,
		maxTokens: options.maxTokens,
	});
	const cooldownSeconds = options.cooldownSeconds ?? 0.0;
	const minTokens = options.minTokens;
	const url = options.url;
	const engineName = options.engine ?? "generic";

	if (trials < 1) {
		console.error("Error: --trials must be at least 1.");
		process.exit(2);
	}
	if (trials > MAX_TRIALS) {
		console.error(`Error: --trials must be <= ${MAX_TRIALS}.`);
		process.exit(2);
	}
	if ((options.ramSampleInterval ?? DEFAULT_RAM_SAMPLE_INTERVAL) <= 0) {
		console.error("Error: --ram-sample-interval must be greater than 0.");
		process.exit(2);
	}
	if (maxTokens < 1) {
		console.error("Error: --max-tokens must be at least 1.");
		process.exit(2);
	}
	if (minTokens !== undefined && minTokens < 1) {
		console.error("Error: --min-tokens must be at least 1.");
		process.exit(2);
	}
	if (minTokens !== undefined && minTokens > maxTokens) {
		console.error("Error: --min-tokens must be <= --max-tokens.");
		process.exit(2);
	}
	if (cooldownSeconds < 0) {
		console.error("Error: --cooldown-seconds must be non-negative.");
		process.exit(2);
	}
	if (!options.model.trim()) {
		console.error("Error: --model must not be empty.");
		process.exit(2);
	}

	const resultsDir = options.outputDir
		? resolve(options.outputDir)
		: join(process.cwd(), "results", "local");

	if (!existsSync(resultsDir)) {
		mkdirSync(resultsDir, { recursive: true });
	}

	let elapsedSinceLast = elapsedSinceLastResult(resultsDir);
	if (elapsedSinceLast !== null) {
		if (cooldownSeconds > elapsedSinceLast) {
			const delay = cooldownSeconds - elapsedSinceLast;
			console.log(
				`Previous benchmark in this output directory was ${elapsedSinceLast.toFixed(1)} seconds ago; cooling down for ${delay.toFixed(1)} seconds.`,
			);
			await new Promise((r) => setTimeout(r, delay * 1000));
			elapsedSinceLast = elapsedSinceLastResult(resultsDir);
		} else if (elapsedSinceLast < RECENT_BENCHMARK_WARNING_SECONDS) {
			console.warn(
				`Warning: previous benchmark in this output directory was ${elapsedSinceLast.toFixed(1)} seconds ago. Consecutive hot runs may be slower; use --cooldown-seconds to enforce a pause.`,
			);
		}
	}

	const progressSampleIntervalTokens =
		profile === BENCHMARK_PROFILE_SUSTAINED
			? SUSTAINED_PROGRESS_SAMPLE_INTERVAL_TOKENS
			: null;

	let result: BenchmarkResultDict;
	try {
		result = await runBenchmark({
			baseUrl: url,
			engineName,
			modelName: options.model,
			trials,
			ramSampleInterval:
				options.ramSampleInterval ?? DEFAULT_RAM_SAMPLE_INTERVAL,
			throughputMaxTokens: maxTokens,
			throughputMinTokens: minTokens ?? null,
			benchmarkProfile: profile,
			elapsedSinceLastBenchmarkSeconds: elapsedSinceLast,
			cooldownSeconds,
			progressSampleIntervalTokens,
		});
	} catch (exc: unknown) {
		const message = exc instanceof Error ? exc.message : String(exc);
		console.error(`Error: ${message}`);
		process.exit(1);
	}

	emitResultWarnings(result);
	logResultSummary(result);

	const reporters: Array<[string, JSONReporter | MarkdownReporter]> = [];
	if (options.format === "json" || options.format === "all") {
		reporters.push(["json", new JSONReporter()]);
	}
	if (options.format === "markdown" || options.format === "all") {
		reporters.push(["markdown", new MarkdownReporter()]);
	}

	const marked = new Marked();
	// marked-terminal types are outdated; the function returns a MarkedExtension
	marked.use(markedTerminal() as Parameters<typeof marked.use>[number]);

	for (const [format, reporter] of reporters) {
		const filePath = reporter.save(result, resultsDir);
		console.log(`Result saved to: ${filePath}`);

		if (format === "markdown") {
			const md = (reporter as MarkdownReporter).generate(result);
			console.log(`\n${marked.parse(md)}`);
		}
	}

	console.log("Done.");
}

export function main(): void {
	const program = new Command();
	program
		.name("guide-mark-ii")
		.description(
			"Benchmark suite for LLM inference performance on Apple Silicon.",
		)
		.version(VERSION);

	program
		.command("run")
		.description("Run a benchmark session")
		.requiredOption(
			"--url <url>",
			"URL of a running OpenAI-compatible server (e.g. 'http://192.168.1.50:8000/v1')",
		)
		.option(
			"--engine <engine>",
			"Engine label for results (default: generic)",
			"generic",
		)
		.requiredOption(
			"--model <model>",
			"Model name exactly as shown in the engine (e.g. 'Qwen3.5-4B-OptiQ-4bit')",
		)
		.option(
			"--trials <number>",
			`Number of trials per metric (default: ${DEFAULT_TRIALS}; sustained profile default: ${SUSTAINED_TRIALS}; max: ${MAX_TRIALS})`,
			Number,
		)
		.option(
			"--profile <profile>",
			`Benchmark profile. 'sustained' defaults to one long throughput trial with max_tokens=${SUSTAINED_THROUGHPUT_MAX_TOKENS} and progress samples every ${SUSTAINED_PROGRESS_SAMPLE_INTERVAL_TOKENS} tokens (default: baseline).`,
			BENCHMARK_PROFILE_BASELINE,
		)
		.option(
			"--ram-sample-interval <seconds>",
			`Seconds between diagnostic engine RSS and system RAM samples (default: ${DEFAULT_RAM_SAMPLE_INTERVAL})`,
			Number,
			DEFAULT_RAM_SAMPLE_INTERVAL,
		)
		.option(
			"--max-tokens <number>",
			`Requested max_tokens for throughput trials (default: ${DEFAULT_THROUGHPUT_MAX_TOKENS}; sustained profile default: ${SUSTAINED_THROUGHPUT_MAX_TOKENS})`,
			Number,
		)
		.option(
			"--min-tokens <number>",
			"Optional requested min_tokens for throughput trials. Use only with engines that support it.",
			Number,
		)
		.option("--format <format>", "Output format (default: json)", "json")
		.option(
			"--cooldown-seconds <seconds>",
			"Wait until at least this many seconds have elapsed since the latest prior JSON result in the output directory (default: 0).",
			Number,
			0.0,
		)
		.option(
			"--output-dir <dir>",
			"Directory for result files (default: ./results/local)",
		)
		.action(async (opts) => {
			await cmdRun({
				url: opts.url as string,
				engine: opts.engine as string | undefined,
				model: opts.model as string,
				trials: opts.trials as number | undefined,
				profile: opts.profile as string | undefined,
				ramSampleInterval: opts.ramSampleInterval as number | undefined,
				maxTokens: opts.maxTokens as number | undefined,
				minTokens: opts.minTokens as number | undefined,
				format: opts.format as string | undefined,
				cooldownSeconds: opts.cooldownSeconds as number | undefined,
				outputDir: opts.outputDir as string | undefined,
			});
		});

	program.parse();
}

main();
