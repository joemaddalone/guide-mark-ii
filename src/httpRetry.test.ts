import { describe, it, expect } from "bun:test";
import { HttpError, isTransientHttpError, requestWithRetry } from "./httpRetry";

describe("isTransientHttpError", () => {
	it("returns true for 500 errors", () => {
		expect(
			isTransientHttpError(new HttpError("Internal Server Error", 500, "/v1")),
		).toBe(true);
	});

	it("returns true for 503 errors", () => {
		expect(
			isTransientHttpError(new HttpError("Service Unavailable", 503, "/v1")),
		).toBe(true);
	});

	it("returns true for 429 rate limit", () => {
		expect(
			isTransientHttpError(new HttpError("Rate Limited", 429, "/v1")),
		).toBe(true);
	});

	it("returns false for 400", () => {
		expect(isTransientHttpError(new HttpError("Bad Request", 400, "/v1"))).toBe(
			false,
		);
	});

	it("returns false for 404", () => {
		expect(isTransientHttpError(new HttpError("Not Found", 404, "/v1"))).toBe(
			false,
		);
	});

	it("returns true for TypeError with 'fetch' in message", () => {
		expect(isTransientHttpError(new TypeError("fetch failed"))).toBe(true);
	});

	it("returns true for TypeError with 'network' in message", () => {
		expect(isTransientHttpError(new TypeError("network error"))).toBe(true);
	});

	it("returns true for TypeError with 'timeout' in message", () => {
		expect(isTransientHttpError(new TypeError("timeout exceeded"))).toBe(true);
	});

	it("returns false for TypeError without relevant keywords", () => {
		expect(isTransientHttpError(new TypeError("invalid argument"))).toBe(false);
	});

	it("returns false for unknown errors", () => {
		expect(isTransientHttpError("string error")).toBe(false);
		expect(isTransientHttpError({ message: "nope" })).toBe(false);
	});
});

describe("requestWithRetry", () => {
	it("succeeds on first attempt with no retry", async () => {
		let calls = 0;
		const result = await requestWithRetry(
			async () => {
				calls++;
				return "ok";
			},
			{ action: "test", attempts: 3, backoffSeconds: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(1);
	});

	it("retries on transient error and succeeds", async () => {
		let calls = 0;
		const result = await requestWithRetry(
			async () => {
				calls++;
				if (calls < 3) throw new HttpError("Server Error", 500, "/v1");
				return "recovered";
			},
			{ action: "test", attempts: 3, backoffSeconds: 0 },
		);
		expect(result).toBe("recovered");
		expect(calls).toBe(3);
	});

	it("throws immediately on non-transient error", async () => {
		let calls = 0;
		await expect(
			requestWithRetry(
				async () => {
					calls++;
					throw new HttpError("Bad Request", 400, "/v1");
				},
				{ action: "test", attempts: 3, backoffSeconds: 0 },
			),
		).rejects.toThrow();
		expect(calls).toBe(1);
	});

	it("throws last error after exhausting all attempts", async () => {
		let calls = 0;
		await expect(
			requestWithRetry(
				async () => {
					calls++;
					throw new HttpError("Server Error", 500, "/v1");
				},
				{ action: "test", attempts: 3, backoffSeconds: 0 },
			),
		).rejects.toThrow();
		expect(calls).toBe(3);
	});

	it("retries on transient TypeError", async () => {
		let calls = 0;
		const result = await requestWithRetry(
			async () => {
				calls++;
				if (calls < 2) throw new TypeError("fetch failed");
				return "ok";
			},
			{ action: "test", attempts: 3, backoffSeconds: 0 },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
	});
});
