# Backtest Forensic Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and correct the mathematical and logical behavior of the MT5 backtester, then produce reproducible diagnostics and real-data validation without optimizing strategy parameters.

**Architecture:** Keep `runBacktest` as the orchestration entry point, but move market-data normalization and execution math into pure helpers shared by tests and live code. Feed the backtester actual broker timeframe series and symbol metadata, produce a full diagnostic ledger, and derive every chart and metric from that ledger.

**Tech Stack:** TypeScript, Vitest, Fastify, Prisma, Python/FastAPI MT5 bridge, React/Next.js.

---

### Task 1: Market Data Integrity

**Files:**
- Create: `backend/src/modules/backtest/market-data.ts`
- Modify: `backend/src/modules/backtest/engine.ts`
- Modify: `backend/src/modules/trading/service.ts`
- Modify: `backend/src/modules/trading/manager.ts`
- Test: `backend/src/tests/backtest-market-data.test.ts`

- [ ] **Step 1: Write failing sorting, deduplication, completed-bar, H4-boundary, and no-lookahead tests**

```ts
expect(normalizeCandles([newer, duplicate, older], "H1", asOf)).toEqual([older, newer]);
expect(completedCandlesAt(h4, "H4", Date.parse("2026-01-01T05:00:00Z"))).not.toContain(partialH4);
```

- [ ] **Step 2: Run the focused test and verify the expected missing-helper failures**

Run: `npm test -- src/tests/backtest-market-data.test.ts`

- [ ] **Step 3: Implement chronological normalization and completed-candle selection**

```ts
export function normalizeCandles(candles: Candle[], timeframe: string, asOfMs = Infinity): Candle[];
export function candlesVisibleAt(candles: Candle[], timeframe: string, asOfMs: number, limit?: number): Candle[];
```

- [ ] **Step 4: Use completed candles in live analysis and live ATR trailing**

- [ ] **Step 5: Run focused and existing indicator tests**

### Task 2: Indicator Direction and Strategy Interpretation

**Files:**
- Modify: `backend/src/modules/analysis/engine.ts`
- Modify: `backend/src/modules/strategy/service.ts`
- Test: `backend/src/tests/strategy-signals.test.ts`

- [ ] **Step 1: Write failing bullish/bearish MACD-cross, RSI-recovery, pattern-direction, and trend-alignment tests**

```ts
expect(evaluateStrategy(strategy, bullishCrossAnalysis).direction).toBe("buy");
expect(evaluateStrategy(strategy, merelyOversoldAnalysis).direction).toBeNull();
```

- [ ] **Step 2: Verify the tests fail against histogram-sign and static-RSI behavior**

- [ ] **Step 3: Expose previous/current RSI, MACD, and signal-line values from `analyzeTimeframe`**

- [ ] **Step 4: Implement actual crossings and hard higher-timeframe alignment without changing configured thresholds**

- [ ] **Step 5: Run signal and indicator tests**

### Task 3: Broker Units and Position Sizing

**Files:**
- Modify: `mt5-bridge/main.py`
- Modify: `backend/src/modules/mt5/client.ts`
- Modify: `backend/src/modules/risk/instruments.ts`
- Modify: `backend/src/modules/risk/engine.ts`
- Test: `backend/src/tests/risk.test.ts`
- Test: `backend/src/tests/instruments.test.ts`

- [ ] **Step 1: Write failing five-digit point, tick-value sizing, volume-step floor, min/max volume, and stop-level tests**

```ts
expect(priceFromPoints(15, eurusdSpec)).toBeCloseTo(0.00015);
expect(calculateLotsWithSpec(10000, 0.5, 1.1, 1.097, eurusdSpec)).toBe(0.16);
```

- [ ] **Step 2: Verify failures**

- [ ] **Step 3: Expose broker symbol metadata and implement tick-size/tick-value sizing with floor-to-step rounding**

- [ ] **Step 4: Keep static instrument metadata only as an explicit fallback**

- [ ] **Step 5: Run risk and instrument tests**

### Task 4: Deterministic Execution Ledger

**Files:**
- Create: `backend/src/modules/backtest/execution.ts`
- Create: `backend/src/modules/backtest/types.ts`
- Modify: `backend/src/modules/backtest/engine.ts`
- Test: `backend/src/tests/backtest-execution.test.ts`

- [ ] **Step 1: Write the required BUY/SELL TP/SL, spread, commission, slippage, P/L-sign, next-bar, same-bar, trailing, and end-close tests**

```ts
expect(resolvePosition(buy, targetOnlyBar, config).exitReason).toBe("tp");
expect(resolvePosition(sell, stopOnlyBar, config).rMultiple).toBeCloseTo(-1);
```

- [ ] **Step 2: Verify failures before implementation**

- [ ] **Step 3: Model MT5 candles as bid OHLC: BUY enters ask/exits bid; SELL enters bid/exits ask**

- [ ] **Step 4: Apply adverse slippage once, round-turn commission once, and configurable same-bar policy**

- [ ] **Step 5: Extract monotonic break-even/ATR stop ratcheting and honor `trailingStop`**

- [ ] **Step 6: Record the full per-trade diagnostic schema and reconcile gross/net P/L**

- [ ] **Step 7: Run focused execution tests**

### Task 5: Metrics, Walk-Forward, and Reconciliation

**Files:**
- Create: `backend/src/modules/backtest/metrics.ts`
- Modify: `backend/src/modules/backtest/engine.ts`
- Test: `backend/src/tests/backtest-metrics.test.ts`
- Test: `backend/src/tests/backtest.test.ts`

- [ ] **Step 1: Write failing metric, final-equity, and warm-up boundary tests**

```ts
expect(result.equityCurve.at(-1)?.equity).toBe(result.stats.finalBalance);
expect(walkForward.consistency.totalTrades).toBeCloseTo(full.stats.trades, 3);
```

- [ ] **Step 2: Verify failures**

- [ ] **Step 3: Derive all requested summary and grouped metrics from the trade ledger**

- [ ] **Step 4: Include warm-up bars per fold while prohibiting pre-window entries**

- [ ] **Step 5: Always preserve the final liquidation point when downsampling the chart**

- [ ] **Step 6: Run backtest tests**

### Task 6: API and UI Diagnostics

**Files:**
- Modify: `backend/src/modules/backtest/routes.ts`
- Modify: `frontend/components/BacktestPanel.tsx`

- [ ] **Step 1: Fetch broker symbol metadata and all configured timeframe candles through one route path**

- [ ] **Step 2: Return the complete diagnostic ledger and cost/ambiguity comparisons**

- [ ] **Step 3: Add JSON and CSV downloads using the returned ledger**

- [ ] **Step 4: Label balance/equity and round-turn commission conventions explicitly**

- [ ] **Step 5: Run backend typecheck and frontend build**

### Task 7: Real-Data Audit Report

**Files:**
- Create: `backend/scripts/audit-backtest.ts`
- Create: `docs/backtest-forensic-audit-2026-06-15.md`

- [ ] **Step 1: Run standard, walk-forward, zero-cost, staged-cost, trailing-disabled, and same-bar-policy comparisons on MT5 EURUSD H1 data**

- [ ] **Step 2: Run the ten requested entry ablations without parameter optimization**

- [ ] **Step 3: Independently recalculate at least 20 selected trades and emit discrepancy rows**

- [ ] **Step 4: Document the full pipeline map, confirmed defects, financial impact, fixes, remaining limitations, and safety verdict**

- [ ] **Step 5: Run the complete backend suite, focused suite, backend typecheck, and frontend build**

