# Plan 003: Dead code cleanup

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat HEAD -- src/engines.ts src/schema.ts src/cli.ts src/benchmark.ts src/reporters.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `<uncommitted>`, 2025-07-18

## Why this matters

~180 lines of dead code across 4 files create confusion about which methods are active, which exports are used, and where the version string lives. Removing dead code simplifies the codebase and eliminates false signals for future contributors.

## Current state

1. **`src/engines.ts:97-100`** — `responseBodyExcerpt` always returns null:
   ```typescript
   protected responseBodyExcerpt(response: Response | null): string | null {
     if (response === null) return null;
     return null; // Must be async or called differently
   }
   ```
   The async version `responseBodyExcerptAsync` at line 102 does the actual work. The sync version is never called.

2. **`src/schema.ts:706-860`** — `BenchmarkResultValidator` class is exported but never imported anywhere in the project. 155 lines of unused validation logic.

3. **`src/schema.ts:862-880`** — `dumpBenchmarkResult` function is exported but never imported anywhere. 18 lines of unused utility.

4. **`src/cli.ts:27` and `src/benchmark.ts:37`** — VERSION constant duplicated:
   ```typescript
   // src/cli.ts:27
   const VERSION = "0.1.0";
   // src/benchmark.ts:37
   const VERSION = "0.1.0";
   ```
   `package.json:3` also has `"version": "0.1.0"` — three sources of truth.

5. **`src/reporters.ts:13`** — Dynamic `require` in ESM module:
   ```typescript
   const { unlinkSync } = require("node:fs");
   ```
   `unlinkSync` is already available from the top-level import on line 1.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |
| Lint      | `bun run lint`           | exit 0              |

## Scope

**In scope**:
- `src/engines.ts` — remove dead `responseBodyExcerpt`, rename async version
- `src/schema.ts` — remove `BenchmarkResultValidator` and `dumpBenchmarkResult`
- `src/constants.ts` — add `VERSION` constant
- `src/cli.ts` — import VERSION from constants, remove local definition
- `src/benchmark.ts` — import VERSION from constants, remove local definition
- `src/reporters.ts` — move `unlinkSync` to top-level import

**Out of scope**:
- `src/benchmark.ts` `runBenchmark` function — no structural changes
- `src/engines.ts` engine class hierarchy — no refactoring

## Git workflow

- Branch: `advisor/003-dead-code`
- One commit for the cleanup
- Do NOT push unless instructed

## Steps

### Step 1: Remove dead responseBodyExcerpt from engines.ts

In `src/engines.ts`, delete lines 97-100 (the sync `responseBodyExcerpt` method):
```typescript
// DELETE this entire method:
protected responseBodyExcerpt(response: Response | null): string | null {
  if (response === null) return null;
  return null; // Must be async or called differently
}
```

Rename `responseBodyExcerptAsync` (line 102) to `responseBodyExcerpt`. Update the single caller if any exists (grep to confirm — there should be none based on the audit).

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 2: Remove BenchmarkResultValidator and dumpBenchmarkResult from schema.ts

In `src/schema.ts`, delete:
- `BenchmarkResultValidator` class (lines 706-860, ~155 lines)
- `dumpBenchmarkResult` function (lines 862-880, ~18 lines)

Before deleting, confirm neither is imported anywhere:
```bash
grep -rn "BenchmarkResultValidator\|dumpBenchmarkResult" src/
```
Expected: only the definition lines in `src/schema.ts`.

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 3: Centralize VERSION constant

In `src/constants.ts`, add at the top (after existing constants):
```typescript
export const VERSION = "0.1.0";
```

In `src/cli.ts`, replace line 27:
```typescript
// BEFORE:
const VERSION = "0.1.0";
// AFTER:
import { VERSION } from "./constants";
```
Move the import to the top-level import block (around line 5-10).

In `src/benchmark.ts`, replace line 37:
```typescript
// BEFORE:
const VERSION = "0.1.0";
// AFTER: (already imports from constants, just add VERSION to the import list)
import { ..., VERSION } from "./constants";
```

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 4: Fix dynamic require in reporters.ts

In `src/reporters.ts`, change line 1 from:
```typescript
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
```
to:
```typescript
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
```

Then delete line 13:
```typescript
// DELETE:
const { unlinkSync } = require("node:fs");
```

**Verify**: `bun run typecheck` → exit 0, no errors

### Step 5: Run all quality gates

**Verify**:
- `bun test` → all pass
- `bun run lint` → exit 0
- `bun run typecheck` → exit 0, no errors

## Test plan

No new tests needed — removing dead code and consolidating a constant. Existing tests should continue to pass. The key verification is that `typecheck` and `test` both pass after each step.

## Done criteria

ALL must hold:
- [ ] `bun test` exits 0
- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `grep -rn "BenchmarkResultValidator\|dumpBenchmarkResult" src/` returns no matches
- [ ] `grep -rn "responseBodyExcerpt[^A]" src/` returns no matches (only the async version should exist)
- [ ] `grep -rn "const VERSION" src/` returns only `src/constants.ts`
- [ ] `grep -rn "require(" src/` returns no matches
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:
- `BenchmarkResultValidator` or `dumpBenchmarkResult` is actually imported somewhere the audit missed
- Removing `responseBodyExcerpt` causes a type error (check if it's referenced in a type definition)
- The VERSION import from `package.json` is preferred over a constant (Bun supports `import { version } from "../package.json"` — if the executor prefers this approach, use it instead of the constants.ts approach)

## Maintenance notes

- After this cleanup, version bumps only require editing `src/constants.ts` and `package.json` (2 files instead of 3).
- If `BenchmarkResultValidator` is needed in the future, it can be reconstructed from the Zod schemas. The Zod refinements already enforce the same invariants.
- The `responseBodyExcerptAsync` rename is a breaking change for any external consumers of the `BaseEngine` class. Since this is a private tool, this is acceptable.
