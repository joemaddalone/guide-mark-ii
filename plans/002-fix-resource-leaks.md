# Plan 002: Fix resource leaks and silent degradation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat HEAD -- src/engines.ts src/benchmark.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `<uncommitted>`, 2025-07-18

## Why this matters

Three correctness issues compound during benchmark runs:
1. `ReadableStreamDefaultReader` locks are never released after SSE streaming, leaking file descriptors over repeated trials (up to 30).
2. Spawned child processes in `sampleCurrentSystemRam` are never explicitly closed, leaking handles during teardown.
3. Silent error swallowing in catch blocks produces benchmark results with zero/fallback values and no machine-readable indication of what went wrong.

## Current state

**Reader lock leak** — `src/engines.ts:361,528`:
```typescript
const reader = response.body?.getReader();
// ... stream reading loop ...
// No reader.releaseLock() on any exit path (early return, break, throw)
```

**Process handle leak** — `src/benchmark.ts:171-195`:
```typescript
const [memsizeProc, vmPagesizeProc] = await Promise.all([
  Bun.spawn(["sysctl", "-n", "hw.memsize"], { stdout: "pipe", stderr: "pipe" }),
  Bun.spawn(["sysctl", "-n", "hw.vm_pagesize"], { stdout: "pipe", stderr: "pipe" }),
]);
// ... read stdout ...
// No proc.kill() or await proc.exited
```

**Silent degradation** — `src/benchmark.ts:573,601,636,720,733,746`:
```typescript
// Example from line 720:
} catch (exc) {
  console.warn(`Diagnostic engine RAM sampling failed during teardown: ${exc}`);
  peakRamGb = null;
  ramIsProcessRss = false;
}
// Result continues with fallback values, no structured degradation info
```

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |
| Lint      | `bun run lint`           | exit 0              |

## Scope

**In scope**:
- `src/engines.ts` — release reader locks in `measureTTFT` and `measureThroughput`
- `src/benchmark.ts` — close spawned processes in `sampleCurrentSystemRam`; add structured degradation logging

**Out of scope**:
- `src/trackers.ts` — tracker cleanup is handled separately by start/stop lifecycle
- `src/detect.ts` — detection functions are not in the hot path

## Git workflow

- Branch: `advisor/002-fix-leaks`
- Commit per logical unit
- Do NOT push unless instructed

## Steps

### Step 1: Release reader locks in measureTTFT

In `src/engines.ts`, in the `measureTTFT` method (line 316), the reader obtained at line 361 is never released. Add a `finally` block to the try/catch that starts at line 329:

```typescript
const reader = response.body?.getReader();
if (!reader) { /* existing error */ }

try {
  // ... existing stream reading loop ...
} finally {
  try { reader.releaseLock(); } catch { /* already released */ }
}
```

The `try/finally` should wrap the `while (!streamDone)` loop (lines 373-401). The `reader.releaseLock()` call must happen after the loop exits (whether by break, return, or throw).

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 2: Release reader locks in measureThroughput

Same pattern in `measureThroughput` (line 422). The reader at line 528 needs a `finally` block around the `while (!streamDone)` loop (lines 528-579).

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 3: Close spawned processes in sampleCurrentSystemRam

In `src/benchmark.ts`, in `sampleCurrentSystemRam` (line 171), after reading `stdout.text()` from each spawned process, explicitly kill it:

```typescript
const [memsizeProc, vmPagesizeProc] = await Promise.all([
  Bun.spawn(["sysctl", "-n", "hw.memsize"], { stdout: "pipe", stderr: "pipe" }),
  Bun.spawn(["sysctl", "-n", "hw.vm_pagesize"], { stdout: "pipe", stderr: "pipe" }),
]);

const [memsizeOutput, pageSizeOutput] = await Promise.all([
  memsizeProc.stdout.text(),
  vmPagesizeProc.stdout.text(),
]);

memsizeProc.kill();
vmPagesizeProc.kill();
```

Same pattern for the `vmStat` process at line 193.

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 4: Add console.warn to silent catch blocks

In `src/benchmark.ts`, in `sampleCurrentSystemRam` (line 215), add a warning before returning the zero tuple:

```typescript
} catch {
  console.warn("System RAM snapshot fallback failed; returning zero values");
  return [0.0, 0.0];
}
```

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 5: Run all quality gates

**Verify**:
- `bun test` → all pass
- `bun run lint` → exit 0
- `bun run typecheck` → exit 0, no errors

## Test plan

No new test file needed — these are targeted fixes to existing code. The existing test suite (`bun test`) should continue to pass. Manual verification: run a benchmark and confirm reader locks are released (no FD accumulation) and process handles are closed.

## Done criteria

ALL must hold:
- [ ] `bun test` exits 0
- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `src/engines.ts` has `reader.releaseLock()` in `finally` blocks for both `measureTTFT` and `measureThroughput`
- [ ] `src/benchmark.ts` has `.kill()` calls on spawned processes in `sampleCurrentSystemRam`
- [ ] `src/benchmark.ts` has `console.warn` in the `sampleCurrentSystemRam` catch block
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- The code at the locations in "Current state" doesn't match the excerpts
- A step's verification fails twice after a reasonable fix attempt
- `reader.releaseLock()` throws an error that wasn't expected (check Bun's ReadableStream implementation)
- Killing a spawned process causes a hang (the process may have already exited)

## Maintenance notes

- `reader.releaseLock()` is idempotent in the spec but may throw if the reader is already released. The `try/catch` around it handles this.
- If benchmark.ts is later refactored to extract `sampleCurrentSystemRam` into a utility, the process cleanup should follow it.
- The `console.warn` in the catch block is a minimal fix. A future improvement could add a `degradation_reasons: string[]` field to the result metadata.
