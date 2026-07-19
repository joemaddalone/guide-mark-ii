import { P95_MIN_TRIALS } from "./constants";

export const DECODE_TIMING_UNAVAILABLE = "unavailable";
export const DECODE_TIMING_CLIENT_STREAM = "client_stream";

export interface ThroughputMeasurement {
	request_tokens_per_second: number;
	completion_tokens: number;
	token_count_source: string;
	elapsed_seconds: number;
	decode_tokens_per_second: number | null;
	decode_elapsed_seconds: number | null;
	decode_timing_source: string;
	progress_samples: ReadonlyArray<Record<string, unknown>>;
}

export function computeStats(values: number[]): {
	mean: number;
	stddev: number;
	min: number;
	max: number;
	p95?: number;
} {
	if (values.length === 0) {
		throw new Error("values must contain at least one measurement");
	}

	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const variance =
		values.length > 1
			? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
				(values.length - 1)
			: 0;
	const stddev = Math.sqrt(variance);

	const result = {
		mean: Math.round(mean * 1000) / 1000,
		stddev: Math.round(stddev * 1000) / 1000,
		min: Math.round(Math.min(...values) * 1000) / 1000,
		max: Math.round(Math.max(...values) * 1000) / 1000,
	};

	if (values.length >= P95_MIN_TRIALS) {
		const sorted = [...values].sort((a, b) => a - b);
		const p95Index = Math.ceil(0.95 * sorted.length) - 1;
		const p95Value = sorted[p95Index];
		if (p95Value !== undefined) {
			return { ...result, p95: Math.round(p95Value * 1000) / 1000 };
		}
	}

	return result;
}
