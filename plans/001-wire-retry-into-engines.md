# Plan 001: Wire httpRetry into engine HTTP paths

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat HEAD -- src/engines.ts src/httpRetry.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security / tech-debt
- **Planned at**: commit `<uncommitted>`, 2025-07-18

## Why this matters

Engine HTTP calls in `measureTTFT` and `measureThroughput` use raw `fetch` with no retry logic. Transient 429 (rate limit) or 5xx (server error) responses crash the benchmark immediately. The `httpRetry` module already implements `requestWithRetry` and `streamWithRetry` with exponential backoff, but it is never imported by any engine code. Wiring retry in protects benchmark runs from transient failures that are common when testing against local inference servers.

## Current state

- `src/httpRetry.ts` — exports `requestWithRetry`, `streamWithRetry`, `HttpError`, `isTransientHttpError`. Fully implemented, zero consumers.
- `src/engines.ts` — `BaseEngine.measureTTFT` (line 316) and `BaseEngine.measureThroughput` (line 422) both use raw `fetchFn(url, ...)` with no retry.
- `src/engines.ts:17-27` — `ResponseError` class wraps HTTP errors with status code and response text.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `bun install`            | exit 0              |
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |
| Lint      | `bun run lint`           | exit 0              |

## Scope

**In scope**:
- `src/engines.ts` — wrap fetch calls in retry logic
- `src/httpRetry.ts` — add tests
- `src/httpRetry.test.ts` — new test file

**Out of scope**:
- `src/benchmark.ts` — no changes to benchmark orchestration
- `src/cli.ts` — no CLI changes

## Git workflow

- Branch: `advisor/001-wire-retry`
- Commit per logical unit
- Do NOT push unless instructed

## Steps

### Step 1: Add httpRetry tests

Create `src/httpRetry.test.ts` with tests for:
- `isTransientHttpError`: returns true for status >= 500 and 429, false for 4xx (except 429)
- `isTransientHttpError`: returns true for TypeError with "fetch"/"network"/"timeout" messages
- `requestWithRetry`: succeeds on first attempt — no retry
- `requestWithRetry`: fails twice with transient error, succeeds on third — returns result
- `requestWithRetry`: fails with non-transient error — throws immediately
- `requestWithRetry`: exhausts all attempts — throws last error

Model after the existing test pattern in `src/stats.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
```

**Verify**: `bun test src/httpRetry.test.ts` → all pass

### Step 2: Wrap measureTTFT fetch in retry

In `src/engines.ts`, import `requestWithRetry` from `./httpRetry`. In `measureTTFT` (starting line 316), wrap the `fetchFn(url, ...)` call (line 330-334) inside a `requestWithRetry` call:

```typescript
import { requestWithRetry } from "./httpRetry";

// Inside measureTTFT, replace the raw fetch:
const response = await requestWithRetry(
  () => fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }),
  { action: "measure TTFT" },
);
```

Keep all the existing error handling (ResponseError construction, reader logic) outside the retry wrapper — only the fetch call itself should be retried.

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 3: Wrap measureThroughput fetch in retry

Same pattern as Step 2 for `measureThroughput` (starting line 422). The fetch call at line 474-478 should be wrapped in `requestWithRetry`:

```typescript
const response = await requestWithRetry(
  () => fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }),
  { action: "measure throughput" },
);
```

Keep the stream_usage fallback logic (`usageAttempts` loop) outside the retry wrapper. The retry should wrap each individual fetch attempt, not the entire loop.

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 4: Run all quality gates

**Verify**:
- `bun test` → all pass (including new httpRetry tests)
- `bun run lint` → exit 0
- `bun run typecheck` → exit 0, no errors

## Test plan

New file: `src/httpRetry.test.ts`
- Tests for `isTransientHttpError` (3 cases)
- Tests for `requestWithRetry` (4 cases: success, transient retry, non-transient fail, exhaustion)
- Pattern: `import { describe, it, expect } from "bun:test";` matching `src/stats.test.ts`

## Done criteria

ALL must hold:
- [ ] `bun test` exits 0; new httpRetry tests exist and pass
- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `src/engines.ts` imports from `./httpRetry` and uses `requestWithRetry`
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- The code at the locations in "Current state" doesn't match the excerpts
- A step's verification fails twice after a reasonable fix attempt
- `requestWithRetry` changes the streaming behavior of `measureThroughput` in unexpected ways (test with a mock server first)
- You discover that `ResponseError` is not caught by `isTransientHttpError` (check the error hierarchy)

## Maintenance notes

- The retry wrapper adds latency on transient failures (up to 3 attempts × backoff). This is acceptable for benchmark runs but could be made configurable via CLI flags in the future.
- If engine-specific subclasses are added later (OllamaEngine, VllmEngine), they inherit retry behavior from BaseEngine automatically.
- The `streamWithRetry` function in httpRetry.ts is designed for opening a stream connection, not for retrying mid-stream errors. Do not use it to retry a streaming SSE response that has already started.
