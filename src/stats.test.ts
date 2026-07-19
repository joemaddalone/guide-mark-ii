import { describe, it, expect } from "bun:test";
import { computeStats } from "./stats";

describe("stats", () => {
	it("computes stats for single value", () => {
		const result = computeStats([5.0]);
		expect(result.mean).toBe(5.0);
		expect(result.stddev).toBe(0);
		expect(result.min).toBe(5.0);
		expect(result.max).toBe(5.0);
		expect(result.p95).toBeUndefined();
	});

	it("computes stats for multiple values", () => {
		const result = computeStats([1.0, 2.0, 3.0, 4.0, 5.0]);
		expect(result.mean).toBe(3.0);
		expect(result.min).toBe(1.0);
		expect(result.max).toBe(5.0);
		expect(result.stddev).toBeGreaterThan(0);
	});

	it("computes p95 for 20+ values", () => {
		const values = Array.from({ length: 20 }, (_, i) => i + 1);
		const result = computeStats(values);
		expect(result.p95).toBeDefined();
		expect(result.p95).toBe(19);
	});

	it("throws for empty array", () => {
		expect(() => computeStats([])).toThrow(
			"values must contain at least one measurement",
		);
	});
});
