# Plan 004: Add schema and reporter tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat HEAD -- src/schema.ts src/reporters.ts src/stats.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `<uncommitted>`, 2025-07-18

## Why this matters

Zod schema refinements enforce data integrity constraints (e.g., "min must be <= max", "ram_measurement_method must match ram_is_process_rss"). If a refinement is buggy, invalid benchmark results will be accepted silently. The MarkdownReporter generates complex multi-section output with no regression safety. Adding tests for these two modules catches data integrity and formatting regressions cheaply.

## Current state

**Schema** — `src/schema.ts`:
- 14 Zod schemas with complex `.refine()` validators
- Key schemas to test: `TrialStatsSchema` (lines 178-204), `MetricsSchema` (lines 231-290), `PhaseTimingsSchema` (lines 458-496), `ThermalMonitorSchema` (lines 498-571), `BenchmarkResultSchema` (lines 636-650)
- Each schema has cross-field invariants enforced by `.refine()`

**Reporters** — `src/reporters.ts`:
- `JSONReporter.save()` — serializes result to JSON, writes to file
- `MarkdownReporter.save()` — generates multi-section Markdown report
- `BenchmarkResultDict` type (lines 130-137) defines the input shape

**Existing test pattern** — `src/stats.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { computeStats } from "./stats";

describe("stats", () => {
  it("computes stats for single value", () => {
    const result = computeStats([5.0]);
    expect(result.mean).toBe(5.0);
    // ...
  });
});
```

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |
| Lint      | `bun run lint`           | exit 0              |

## Scope

**In scope**:
- `src/schema.test.ts` — new test file for Zod schema validation
- `src/reporters.test.ts` — new test file for reporter output

**Out of scope**:
- `src/schema.ts` — no changes to schema definitions
- `src/reporters.ts` — no changes to reporter logic
- `src/benchmark.ts` — no integration tests

## Git workflow

- Branch: `advisor/004-schema-reporter-tests`
- One commit per test file
- Do NOT push unless instructed

## Steps

### Step 1: Create schema.test.ts

Create `src/schema.test.ts` with tests for the key Zod schemas:

```typescript
import { describe, it, expect } from "bun:test";
import {
  TrialStatsSchema,
  MetricsSchema,
  PhaseTimingsSchema,
  ThermalMonitorSchema,
  BenchmarkResultSchema,
} from "./schema";
```

Test cases for `TrialStatsSchema`:
- Valid input passes: `{ mean: 1.0, stddev: 0.5, min: 0.5, max: 1.5 }`
- Rejects when min > max: `{ mean: 1.0, stddev: 0.5, min: 2.0, max: 1.0 }`
- Rejects when mean outside [min, max]: `{ mean: 3.0, stddev: 0.5, min: 0.0, max: 2.0 }`
- Rejects when stddev != 0 but min == max: `{ mean: 1.0, stddev: 0.5, min: 1.0, max: 1.0 }`

Test cases for `PhaseTimingsSchema`:
- Valid input passes: `{ warmup: 1.0, ttft_cold: 2.0, cache_priming: 0.5, ttft_cached: 1.5, throughput: 5.0, total_runtime: 10.0 }`
- Rejects when total_runtime < sum of phases
- Rejects when total_runtime exceeds phases by more than 30s

Test cases for `ThermalMonitorSchema`:
- Valid nominal input passes
- Rejects when non_nominal_observed is false but worst_state is "serious"
- Rejects when changed_during_run is false but start_state != end_state

**Verify**: `bun test src/schema.test.ts` → all pass

### Step 2: Create reporters.test.ts

Create `src/reporters.test.ts` with tests for MarkdownReporter output:

```typescript
import { describe, it, expect } from "bun:test";
import { MarkdownReporter } from "./reporters";
import type { BenchmarkResultDict } from "./reporters";
```

Create a minimal valid `BenchmarkResultDict` fixture (use the schema types to construct it). Test cases:
- `MarkdownReporter.save()` produces a file containing "## Hardware" section
- `MarkdownReporter.save()` produces a file containing "## Metrics" section
- `MarkdownReporter.save()` produces a file containing the model name
- `MarkdownReporter.save()` produces a file containing the engine name
- `MarkdownReporter.save()` creates the output directory if it doesn't exist

Use `tmpdir()` for test output to avoid polluting the project:
```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "reporter-test-"));
```

**Verify**: `bun test src/reporters.test.ts` → all pass

### Step 3: Run all quality gates

**Verify**:
- `bun test` → all pass (including new schema and reporter tests)
- `bun run lint` → exit 0
- `bun run typecheck` → exit 0, no errors

## Test plan

New files:
- `src/schema.test.ts` — ~12 test cases across 4 schemas
- `src/reporters.test.ts` — ~5 test cases for MarkdownReporter

Pattern: `import { describe, it, expect } from "bun:test";` matching `src/stats.test.ts`

Key test scenarios:
- Schema happy paths (valid input passes)
- Schema rejection paths (specific invalid inputs trigger expected errors)
- Reporter output contains expected sections
- Reporter creates output directory

## Done criteria

ALL must hold:
- [ ] `bun test` exits 0; new schema and reporter tests exist and pass
- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `src/schema.test.ts` exists with tests for TrialStatsSchema, PhaseTimingsSchema, ThermalMonitorSchema
- [ ] `src/reporters.test.ts` exists with tests for MarkdownReporter output
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- The schema types have changed since this plan was written (drift check)
- Constructing a valid `BenchmarkResultDict` fixture is too complex (use a partial fixture and test individual schemas instead)
- Zod v4 has different API than expected (check `node_modules/zod` version)

## Maintenance notes

- When new schemas are added or `.refine()` validators change, add corresponding test cases.
- The `BenchmarkResultDict` fixture may drift as the schema evolves. Keep it in sync with the actual schema output.
- These are pure unit tests with no side effects — they run fast and should never be skipped.
