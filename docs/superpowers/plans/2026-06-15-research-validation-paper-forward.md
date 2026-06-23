# Research Validation and Paper-Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic Monte Carlo confidence intervals, explicit held-out OOS and portfolio gates, durable validation evidence, and live-market paper-forward execution without broker orders.

**Architecture:** Pure research modules calculate resampling, OOS, and portfolio evidence from existing backtest results. Strategy Lab splits history before any candidate validation and persists a `ValidationRun`. Paper-forward mode reuses the production signal, AI, and risk pipeline, but writes `PaperTrade` rows and reconciles them from live ticks instead of calling `placeOrder`.

**Tech Stack:** TypeScript, Vitest, Prisma/Postgres, existing backtest engine, Fastify, MT5 market-data reads.

---

### Task 1: Monte Carlo Resampling

**Files:**
- Create: `backend/src/modules/backtest/monte-carlo.ts`
- Create: `backend/src/tests/backtest-monte-carlo.test.ts`
- Modify: `backend/src/modules/backtest/types.ts`
- Modify: `backend/src/modules/backtest/routes.ts`

- [ ] Write failing tests for deterministic seeded bootstrap output, percentile ordering, and empty-trade behavior.
- [ ] Run `npm test -- --run src/tests/backtest-monte-carlo.test.ts` and verify RED.
- [ ] Implement `runMonteCarlo(trades, initialBalance, { iterations, seed })` using trade-sequence bootstrap resampling and return 5th/50th/95th percentiles for return, final balance, and max drawdown.
- [ ] Add Monte Carlo evidence to backtest API responses.
- [ ] Re-run the test and verify GREEN.

### Task 2: OOS and Portfolio Gates

**Files:**
- Create: `backend/src/modules/backtest/validation.ts`
- Create: `backend/src/tests/backtest-validation.test.ts`
- Modify: `backend/src/modules/strategy/lab.ts`

- [ ] Write failing tests for an 80/20 chronological split, OOS trade isolation, portfolio aggregation, and pass/fail reasons.
- [ ] Run `npm test -- --run src/tests/backtest-validation.test.ts` and verify RED.
- [ ] Implement `splitTrainOos`, `evaluateOosGate`, and `aggregatePortfolioValidation` with explicit thresholds and rejection reasons.
- [ ] Change Strategy Lab so walk-forward and sensitivity use only training candles, the final 20% is evaluated once as OOS, and the candidate is also evaluated across the supported instrument basket.
- [ ] Re-run validation and lab tests and verify GREEN.

### Task 3: Durable Validation Evidence

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260615_research_validation/migration.sql`
- Modify: `backend/src/modules/strategy/lab.ts`
- Modify: `backend/src/modules/strategy/routes.ts`
- Create: `backend/src/tests/validation-runs.test.ts`

- [ ] Write failing tests for persisting complete gate evidence and listing runs by strategy/candidate.
- [ ] Add `ValidationRun` with user, strategy, candidate name, status, date ranges, instruments, metrics, gate results, rejection reasons, and timestamps.
- [ ] Persist one run per proposal and expose `GET /api/strategies/validation-runs`.
- [ ] Generate Prisma and verify tests pass.

### Task 4: Paper-Forward Data Model and Service

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Extend: `backend/prisma/migrations/20260615_research_validation/migration.sql`
- Create: `backend/src/modules/trading/paper.ts`
- Create: `backend/src/tests/paper-trading.test.ts`

- [ ] Write failing tests for opening without broker calls, SL/TP reconciliation from executable bid/ask, P&L calculation, and stale-trade incident reporting.
- [ ] Add `PaperTradeStatus` and `PaperTrade` with proposal, market snapshot, expected costs, lifecycle timestamps, simulated fills, outcome, strategy, and user relations.
- [ ] Implement `openPaperTrade`, `reconcilePaperTrades`, and `paperPerformance`.
- [ ] Re-run tests and verify GREEN.

### Task 5: Pipeline and Scheduler Integration

**Files:**
- Modify: `backend/src/modules/system/state.ts`
- Modify: `backend/src/modules/system/routes.ts`
- Modify: `backend/src/modules/trading/service.ts`
- Modify: `backend/src/workers/scheduler.ts`
- Modify: `backend/src/modules/trading/routes.ts`
- Modify: `docs/API.md`
- Modify: `backend/src/tests/trading-pipeline.test.ts`

- [ ] Add a failing pipeline test proving paper-forward mode records a paper trade and never calls `mt5.placeOrder`.
- [ ] Add `paperForward` to bot state, admin enable/disable routes, and dashboard-readable status.
- [ ] Branch after the risk gate: paper-forward opens a `PaperTrade`; manual/semi/auto behavior remains unchanged when disabled.
- [ ] Reconcile open paper trades on every scheduler cycle and expose list/performance APIs.
- [ ] Run pipeline, paper, and scheduler-related tests and verify GREEN.

### Task 6: Phase Verification

- [ ] Run `npx prisma generate`.
- [ ] Run `npx prisma migrate deploy` against the local demo database.
- [ ] Run `npm run verify` in `backend`.
- [ ] Run `npm run verify` in `frontend`.
- [ ] Run `git diff --check`.
