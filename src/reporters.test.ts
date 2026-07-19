import { describe, it, expect } from "bun:test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownReporter } from "./reporters";
import type { BenchmarkResultDict } from "./reporters";

function makeFixture(): BenchmarkResultDict {
	return {
		hardware: {
			chip: "Apple M2",
			machine_model: "Mac14,2",
			memory_gb: 16,
			macos_version: "15.3.1",
			thermal_state: "nominal",
		},
		engine: {
			name: "llama.cpp",
			version: "0.1.0",
		},
		model: {
			name: "Qwen3.5-9B",
			quantization: "4bit",
		},
		metrics: {
			tokens_per_second: { mean: 10.5, stddev: 1.2, min: 8.0, max: 12.0 },
			ttft_cold: { mean: 0.5, stddev: 0.1, min: 0.3, max: 0.7 },
			ttft_cached: { mean: 0.2, stddev: 0.05, min: 0.1, max: 0.3 },
			ram_peak_gb: 8.0,
			ram_is_process_rss: true,
			ram_measurement_method: "process_rss",
			system_ram_peak_gb: 12.0,
			system_ram_peak_percent: 75.0,
			token_count_source: "usage.completion_tokens",
		},
		trials: {
			count: 5,
			ttft_cold_raw: [0.4, 0.5, 0.6, 0.5, 0.4],
			ttft_cached_raw: [0.2, 0.15, 0.25, 0.2, 0.18],
			tokens_per_second_raw: [10.0, 11.0, 10.5, 9.8, 11.2],
			throughput_elapsed_seconds_raw: [1.0, 1.1, 1.05, 1.02, 1.08],
			completion_tokens_raw: [10, 12, 11, 10, 12],
		},
		meta: {
			timestamp: "2025-07-18T12:00:00Z",
			chronos_version: "1.0.0",
			benchmark_profile: "baseline",
			phase_timings_seconds: {
				warmup: 2.0,
				ttft_cold: 3.0,
				cache_priming: 1.0,
				ttft_cached: 2.0,
				throughput: 10.0,
				total_runtime: 18.0,
			},
			warmup_failures: 0,
			word_fallback_warning: false,
			engine_version_warning: false,
			sustained_throttling_warning: false,
			cached_ttft_warning: false,
		},
	};
}

describe("MarkdownReporter", () => {
	const testDir = mkdtempSync(join(tmpdir(), "reporter-test-"));

	it("produces a file containing '## Hardware' section", () => {
		const reporter = new MarkdownReporter();
		const outputPath = reporter.save(makeFixture(), testDir);
		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("## Hardware");
	});

	it("produces a file containing '## Metrics' section", () => {
		const reporter = new MarkdownReporter();
		const outputPath = reporter.save(makeFixture(), testDir);
		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("## Metrics");
	});

	it("produces a file containing the model name", () => {
		const reporter = new MarkdownReporter();
		const outputPath = reporter.save(makeFixture(), testDir);
		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("Qwen3.5-9B");
	});

	it("produces a file containing the engine name", () => {
		const reporter = new MarkdownReporter();
		const outputPath = reporter.save(makeFixture(), testDir);
		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("llama.cpp");
	});

	it("creates the output directory if it doesn't exist", () => {
		const reporter = new MarkdownReporter();
		const nestedDir = join(testDir, "nested", "output");
		const outputPath = reporter.save(makeFixture(), nestedDir);
		const content = readFileSync(outputPath, "utf-8");
		expect(content).toContain("## Hardware");
	});
});
