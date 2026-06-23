# Trading Safety and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the active 2FA bypass, directly test broker-to-database trade reconciliation, and make the existing CI workflow enforce the repository's supported checks.

**Architecture:** Keep live-trading safety centralized in the typed environment config and local runtime env files. Move closed-trade reconciliation out of the scheduler into a focused trading module so its broker, database, notification, and audit behavior can be tested without starting timers. Retain the existing GitHub Actions split between backend and frontend while invoking package scripts and validating the production frontend build.

**Tech Stack:** TypeScript, Vitest, Prisma mocks, Node.js 20, Next.js, GitHub Actions.

---

### Task 1: Make 2FA fail-safe

**Files:**
- Create: `backend/src/tests/config.test.ts`
- Modify: `backend/src/config.ts`
- Modify: `.env.example`
- Modify locally: `.env`
- Modify locally: `backend/.env`

- [x] **Step 1: Write a failing config test**

Add a Vitest case that clears `REQUIRE_2FA`, supplies the required secrets and database URL, resets the module cache, imports `config.ts`, and expects `config.REQUIRE_2FA` to be `true`.

- [x] **Step 2: Verify the test fails for the current unsafe default**

Run: `npm test -- --run src/tests/config.test.ts`

Expected: FAIL because the current default is `false`.

- [x] **Step 3: Change the default and runtime settings**

Change `REQUIRE_2FA` to default to `true`, set `.env.example` to `REQUIRE_2FA=true`, and set both local runtime env files to safe values: `DEMO_MODE=true`, `LIVE_TRADING_ENABLED=false`, and `REQUIRE_2FA=true`.

- [x] **Step 4: Verify the config test passes**

Run: `npm test -- --run src/tests/config.test.ts`

Expected: PASS.

### Task 2: Test closed-trade reconciliation

**Files:**
- Create: `backend/src/modules/trading/reconciliation.ts`
- Create: `backend/src/tests/trading-reconciliation.test.ts`
- Modify: `backend/src/workers/scheduler.ts`

- [x] **Step 1: Write failing reconciliation tests**

Cover these behaviors through the public `syncClosedTrades()` API:

```ts
it("closes a missing broker position with summed position deal profit", async () => {
  // EXECUTED trade is absent from live positions; two deals share position_id.
  // Expect CLOSED, a summed profit, notification, and websocket broadcast.
});

it("records an unattributed closure and leaves profit null when history is unavailable", async () => {
  // Expect CLOSED with null profit and a scheduler error audit.
});

it("backfills profit for a recently closed trade", async () => {
  // Expect a profit-only update when matching deal history appears later.
});

it("does nothing when account info is unavailable", async () => {
  // Expect no trade queries because account ownership cannot be established.
});
```

- [x] **Step 2: Verify the tests fail because the module does not exist**

Run: `npm test -- --run src/tests/trading-reconciliation.test.ts`

Expected: FAIL resolving `modules/trading/reconciliation.js`.

- [x] **Step 3: Extract the existing reconciliation implementation**

Move the current `syncClosedTrades` implementation unchanged into `modules/trading/reconciliation.ts`, export it, and import it from `workers/scheduler.ts`. Keep account scoping, history fallback, notifications, broadcasts, and backfill behavior intact.

- [x] **Step 4: Verify reconciliation and pipeline tests pass**

Run: `npm test -- --run src/tests/trading-reconciliation.test.ts src/tests/trading-pipeline.test.ts`

Expected: PASS.

### Task 3: Finish the CI gate

**Files:**
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Modify: `.github/workflows/ci.yml`

- [x] **Step 1: Add explicit verification scripts**

Add a backend `verify` script that runs typecheck and tests. Add frontend `typecheck` and `verify` scripts, with frontend verification running typecheck followed by `next build`.

- [x] **Step 2: Use package scripts in CI**

Keep `npm ci` and Prisma generation, then run `npm run verify` in each job. This makes local and CI verification use the same commands.

- [x] **Step 3: Run CI-equivalent checks locally**

Run: `npm run verify` in `backend`.

Expected: all TypeScript checks and Vitest tests pass.

Run: `npm run verify` in `frontend`.

Expected: TypeScript and Next.js production build pass.

### Task 4: Final verification

**Files:**
- Review all files changed by Tasks 1-3.

- [x] **Step 1: Verify safety flags without printing secrets**

Run: `rg -n "^(DEMO_MODE|LIVE_TRADING_ENABLED|REQUIRE_2FA)=" .env backend/.env .env.example`

Expected: demo enabled, live trading disabled, and 2FA required in both local runtime files; safe defaults in the example.

- [x] **Step 2: Review the final diff**

Run: `git diff --check`

Expected: no whitespace errors.

- [x] **Step 3: Confirm no unrelated user changes were reverted**

Run: `git status --short`

Expected: pre-existing modified/untracked files remain present; only the scoped files above contain new edits from this task.
