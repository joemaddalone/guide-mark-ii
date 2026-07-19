import { describe, it, expect } from "bun:test";
import {
	MAX_TRIALS,
	P95_MIN_TRIALS,
	COLD_PROMPTS,
	THROUGHPUT_PROMPTS,
	buildBenchmarkProtocol,
} from "./constants";

describe("constants", () => {
	it("has correct MAX_TRIALS", () => {
		expect(MAX_TRIALS).toBe(30);
	});

	it("has correct P95_MIN_TRIALS", () => {
		expect(P95_MIN_TRIALS).toBe(20);
	});

	it("has 30 cold prompts", () => {
		expect(COLD_PROMPTS).toHaveLength(30);
	});

	it("has 30 throughput prompts", () => {
		expect(THROUGHPUT_PROMPTS).toHaveLength(30);
	});

	it("builds benchmark protocol with default values", () => {
		const protocol = buildBenchmarkProtocol(5, 100, null);
		expect(protocol.name).toBe("baseline");
		expect(protocol.version).toBe("3");
		expect(protocol.ttft_cold.prompts).toHaveLength(5);
		expect(protocol.throughput.prompts).toHaveLength(5);
	});

	it("throws on invalid connection mode", () => {
		expect(() =>
			buildBenchmarkProtocol(5, 100, null, "baseline", "invalid"),
		).toThrow("connection_mode must be one of");
	});
});
