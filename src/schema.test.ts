import { describe, it, expect } from "bun:test";
import {
	TrialStatsSchema,
	PhaseTimingsSchema,
	ThermalMonitorSchema,
} from "./schema";

function expectReject(
	schema: { parse: (v: unknown) => unknown },
	value: unknown,
) {
	expect(() => schema.parse(value)).toThrow();
}

describe("TrialStatsSchema", () => {
	it("accepts valid input", () => {
		expect(() =>
			TrialStatsSchema.parse({
				mean: 1.0,
				stddev: 0.5,
				min: 0.5,
				max: 1.5,
			}),
		).not.toThrow();
	});

	it("rejects when min > max", () => {
		expectReject(TrialStatsSchema, {
			mean: 1.0,
			stddev: 0.5,
			min: 2.0,
			max: 1.0,
		});
	});

	it("rejects when mean outside [min, max]", () => {
		expectReject(TrialStatsSchema, {
			mean: 3.0,
			stddev: 0.5,
			min: 0.0,
			max: 2.0,
		});
	});

	it("rejects when stddev != 0 but min == max", () => {
		expectReject(TrialStatsSchema, {
			mean: 1.0,
			stddev: 0.5,
			min: 1.0,
			max: 1.0,
		});
	});
});

describe("PhaseTimingsSchema", () => {
	it("accepts valid input", () => {
		expect(() =>
			PhaseTimingsSchema.parse({
				warmup: 1.0,
				ttft_cold: 2.0,
				cache_priming: 0.5,
				ttft_cached: 1.5,
				throughput: 5.0,
				total_runtime: 10.0,
			}),
		).not.toThrow();
	});

	it("rejects when total_runtime < sum of phases", () => {
		expectReject(PhaseTimingsSchema, {
			warmup: 5.0,
			ttft_cold: 5.0,
			cache_priming: 5.0,
			ttft_cached: 5.0,
			throughput: 5.0,
			total_runtime: 10.0,
		});
	});

	it("rejects when total_runtime exceeds phases by more than 30s", () => {
		expectReject(PhaseTimingsSchema, {
			warmup: 1.0,
			ttft_cold: 1.0,
			cache_priming: 0.5,
			ttft_cached: 1.0,
			throughput: 1.0,
			total_runtime: 40.0,
		});
	});
});

describe("ThermalMonitorSchema", () => {
	it("accepts valid nominal input", () => {
		expect(() =>
			ThermalMonitorSchema.parse({
				sample_interval_seconds: 1.0,
				source: "foundation",
				start_state: "nominal",
				end_state: "nominal",
				worst_state: "nominal",
				samples: 10,
				changed_during_run: false,
				non_nominal_observed: false,
			}),
		).not.toThrow();
	});

	it("rejects when non_nominal_observed is false but worst_state is serious", () => {
		expectReject(ThermalMonitorSchema, {
			sample_interval_seconds: 1.0,
			source: "foundation",
			start_state: "nominal",
			end_state: "serious",
			worst_state: "serious",
			samples: 10,
			changed_during_run: true,
			non_nominal_observed: false,
		});
	});

	it("rejects when changed_during_run is false but start_state != end_state", () => {
		expectReject(ThermalMonitorSchema, {
			sample_interval_seconds: 1.0,
			source: "foundation",
			start_state: "nominal",
			end_state: "fair",
			worst_state: "fair",
			samples: 10,
			changed_during_run: false,
			non_nominal_observed: true,
		});
	});
});
