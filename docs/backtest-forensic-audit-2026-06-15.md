# Trading Backtest Forensic Audit

Date: 2026-06-15  
Dataset: EURUSDm broker H1/H4 candles, 2025-05-28 through 2026-06-15  
Primary bars requested: 6,508; current unfinished bar excluded at evaluation time

## A. Verdict

**Both the strategy and backtester contained problems.**

The original -72% result was materially distorted by execution defects, especially converting five-digit broker points with pip size. After correcting point units, bid/ask execution, signal crossings, completed-candle handling, walk-forward warm-up, DST sessions, trailing control, and ledger reconciliation, the supplied full strategy remains unprofitable:

- Realistic costs: **-16.52%, PF 0.68, 178 trades, 18.93% max drawdown**
- Zero costs: **-0.85%, PF 0.98, 177 trades, 9.04% max drawdown**
- Walk-forward: **0/4 profitable folds, mean -4.36%, average PF 0.70**

The strategy is therefore not proven profitable even after removing the engine distortions. Live trading must remain blocked.

## Before And After

| Metric | Original engine | Corrected engine |
|---|---:|---:|
| Trades | 380 | 178 |
| Win rate | 15.3% | 37.6% |
| Profit factor | 0.25 | 0.68 |
| Expectancy | -$19.04 | -$9.28 |
| Net return | -72.36% | -16.52% |
| Max drawdown | 72.38% | 18.93% |
| Final balance | $2,764.21 | $8,348.38 |
| Walk-forward trades | 347 | 178 |
| Walk-forward profitable folds | 0/4 | 0/4 |
| Chart vs final balance | $2,784.32 vs $2,764.21 | $8,348.38 vs $8,348.38 |

The original final balance varied slightly from the reported $2,765.01 because the connected dataset advanced after the screenshot. The reproduced behavior and discrepancy were otherwise the same.

## Pipeline Map

| Stage | File and function |
|---|---|
| Strategy JSON load | `backend/src/modules/backtest/routes.ts` `loadCandles`; Prisma `strategy.config` |
| Config validation/defaults | `backend/src/modules/strategy/types.ts` `StrategyConfigSchema` |
| Broker symbol resolution | `backend/src/modules/mt5/client.ts` `matchBrokerSymbol`, `resolveSymbol` |
| Candle retrieval | `backend/src/modules/mt5/client.ts` `mt5.candles`; `mt5-bridge/main.py` `RealBroker.candles` |
| Symbol digits/ticks/volume | `backend/src/modules/mt5/client.ts` `symbolInfo`; `mt5-bridge/main.py` `symbol_info` |
| Ordering/dedup/completion | `backend/src/modules/backtest/market-data.ts` `normalizeCandles`, `candlesVisibleAt` |
| Indicators | `backend/src/modules/analysis/indicators.ts`; `analysis/engine.ts` `analyzeTimeframe` |
| Higher timeframe | Actual broker H4 fetched in `backtest/routes.ts`; visibility enforced by `candlesVisibleAt` |
| Session/DST | `backend/src/modules/analysis/engine.ts` `detectSession` |
| Signal and rule confidence | `backend/src/modules/strategy/service.ts` `evaluateStrategy` |
| ATR SL/TP | `strategy/service.ts` `deriveLevels`; distance applied at actual entry by `backtest/execution.ts` |
| Next-bar entry | `backend/src/modules/backtest/engine.ts` pending-entry loop |
| Spread/slippage | `backend/src/modules/backtest/execution.ts` `enterPosition`, `resolveBar`, `closeAtMarket` |
| Lot sizing | `backend/src/modules/risk/engine.ts` `calculateLots` |
| Break-even/trailing | Shared `backtest/execution.ts` `calculateManagedStop`; live caller `trading/manager.ts` |
| Exit and P/L | `backtest/execution.ts` `resolveBar`; ledger assembly in `backtest/engine.ts` |
| Metrics | `backend/src/modules/backtest/metrics.ts` `calculateBacktestStats` |
| Walk-forward | `backend/src/modules/backtest/engine.ts` `runWalkForward` |
| UI/chart/download | `frontend/components/BacktestPanel.tsx` |

The configured strategy live path and backtester now share analysis, strategy evaluation, level derivation, lot sizing, and managed-stop math. The live path additionally has news, AI, account-wide risk, approval, and broker execution gates that cannot be historically replayed from the available data.

The autonomous scanner is a separate signal source, not the supplied strategy. Its duplicated RSI/MACD direction logic was also corrected, but scanner suggestions remain outside this strategy backtest.

## B. Defect Report

### Critical: broker points treated as pips

- Location: old `backend/src/modules/backtest/engine.ts` `pointSize`
- Current behavior: EURUSD `15` points became `0.0015` (15 pips), not `0.00015` (1.5 pips).
- Expected: use broker `point`, tick size, tick value, digits, and volume metadata.
- Financial impact: dominant contributor to the original -72% collapse. Corrected full result is -16.52%.
- Fix: broker symbol metadata endpoint plus `priceDistanceFromPoints` and tick-based money math.
- Regression: `execution-units.test.ts`.

### Critical: repeated live evaluation of the same completed bar

- Location: `backend/src/workers/scheduler.ts` one-minute loop and `trading/service.ts` `evaluateAndMaybeTrade`.
- Current behavior: the same H1 signal could be evaluated up to 60 times because no bar checkpoint existed.
- Expected: one strategy evaluation per completed primary candle per strategy/symbol.
- Financial impact: live trade frequency could materially exceed the backtest and violate model assumptions.
- Fix: persistent `strategy-bar:<strategy>:<symbol>` checkpoint after successful deterministic evaluation.
- Regression: `backtest-market-data.test.ts` checkpoint logic.

### High: MACD sign used instead of MACD crossing

- Location: `backend/src/modules/strategy/service.ts` `evaluateStrategy`; scanner `scoreSymbol`.
- Current behavior: any positive histogram scored BUY and any negative histogram scored SELL.
- Expected: compare previous/current MACD line against previous/current signal line.
- Financial impact: stale momentum generated repeated entries; corrected trade count fell from 380 to 178 with the other execution fixes.
- Fix: expose aligned MACD and signal values and require an actual crossing.
- Regression: `strategy-signals.test.ts`, `scanner-signals.test.ts`.

### High: static RSI extremes traded instead of recoveries

- Location: `backend/src/modules/strategy/service.ts` `evaluateStrategy`; scanner `scoreSymbol`.
- Current behavior: RSI below 40 immediately authorized bullish score; RSI above 60 authorized bearish score.
- Expected: BUY recovery through 40; SELL fall through 60.
- Financial impact: entries occurred while momentum was still moving against the trade.
- Fix: previous/current RSI crossing rules.
- Regression: `strategy-signals.test.ts`.

### High: incomplete live candles and repeated current-bar signals

- Location: `backend/src/modules/trading/service.ts`, `trading/scanner.ts`, `trading/manager.ts`.
- Current behavior: MT5 position zero includes the unfinished candle and was passed directly into indicators.
- Expected: calculate signals and ATR only from bars whose close boundary is at or before the tick time.
- Financial impact: unstable indicators and live/backtest divergence.
- Fix: shared `normalizeCandles` completed-bar filter.
- Regression: `backtest-market-data.test.ts`.

### High: spread-side execution was mathematically wrong

- Location: old `backend/src/modules/backtest/engine.ts` entry/exit math.
- Current behavior: MT5 bid OHLC was treated as midpoint OHLC and half-spread was moved on both sides.
- Expected: BUY enters ask/exits bid; SELL enters bid/exits ask; spread is embedded exactly once.
- Financial impact: incorrect entries, stop/target touches, equity, and P/L.
- Fix: bid-bar execution ledger in `backtest/execution.ts`.
- Regression: `backtest-execution.test.ts`.

### High: walk-forward discarded warm-up at every fold

- Location: old `backend/src/modules/backtest/engine.ts` `runWalkForward`.
- Current behavior: each fold independently skipped its first 200 bars, producing 347 trades versus 380.
- Expected: include pre-window warm-up data but prohibit entries before the fold start.
- Financial impact: 33 trades disappeared in the reproduced original run.
- Fix: each fold now includes a 200-bar warm-up and uses the same `runBacktest` path.
- Regression: `backtest.test.ts`; corrected standard and fold total are both 178.

### High: final chart omitted forced liquidation

- Location: old `backend/src/modules/backtest/engine.ts` equity downsampling/final close.
- Current behavior: forced end close updated balance after the last chart point; downsampling could also omit the final point.
- Expected: final equity equals final realized balance after end liquidation.
- Financial impact: reproduced $2,784.32 chart versus $2,764.21 balance.
- Fix: append/replace final liquidation point and always preserve it during downsampling.
- Regression: `backtest.test.ts`.

### Medium: trailing flag ignored and break-even mislabeled

- Location: old `backend/src/modules/backtest/engine.ts` open-position management.
- Current behavior: ATR trailing ran whether `trailingStop` was true or false; break-even exits were labeled `trail`.
- Expected: break-even always follows the live rule; ATR trailing only when enabled; exit labels remain distinct.
- Financial impact after corrections: enabled -16.52% versus disabled -16.76%, a +$24.67 difference.
- Fix: shared `calculateManagedStop`; separate `break_even` and `trail` reasons.
- Regression: `backtest-execution.test.ts`.

### Medium: fixed UTC session boundaries ignored DST

- Location: `backend/src/modules/analysis/engine.ts` `detectSession`; duplicate `sessionNow`.
- Current behavior: winter overlap started at 12:00 UTC instead of 13:00 UTC.
- Expected: London and New York local 08:00-17:00 windows using IANA time zones.
- Financial impact: changed the eligible trade set and final corrected result.
- Fix: DST-aware shared detector; removed duplicate fixed-hour logic.
- Regression: `backtest.test.ts` DST cases.

### Medium: nearest-step lot rounding could over-risk

- Location: old `backend/src/modules/risk/engine.ts` `calculateLots`.
- Current behavior: calculated volume rounded to nearest 0.01 and ignored broker volume metadata.
- Expected: floor to volume step and clamp to broker/configured limits.
- Financial impact: a $50 target risk with a 30-pip EURUSD stop rounded to 0.17 lots ($51) instead of 0.16 ($48).
- Fix: tick-value sizing with floor-to-step rounding.
- Regression: `execution-units.test.ts`.

### Safety: live environment was enabled without strategy certification

- Location: `backend/src/config.ts`, `risk/engine.ts`, `trading/service.ts`.
- Current behavior: local `LIVE_TRADING_ENABLED` was true and no backtest certification gate existed.
- Expected: live orders remain blocked until deterministic and OOS criteria pass.
- Fix: mandatory `STRATEGY_VALIDATION_APPROVED=false` gate, checked for every live trade.
- Regression: `risk.test.ts` live-gate tests.

## Risk Sizing Finding

`riskPct: 0.5` was already interpreted as **0.5%**, not 50%. A $10,000 balance targets $50 risk. Corrected early trades show initial risk near $48-$50 after floor-to-step volume rounding.

Losses around $14-$16 in the original late trade list were primarily caused by compounding: after the defective run reduced balance to roughly $2,800, 0.5% risk was only about $14. The observation did not prove a double percentage division or fixed-lot override.

## Cost Ablation

| Costs | Trades | Win rate | PF | Expectancy | Return | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| None | 177 | 45.2% | 0.98 | -$0.48 | -0.85% | 9.04% |
| Spread only | 176 | 38.6% | 0.77 | -$6.41 | -11.28% | 14.02% |
| Spread + commission | 176 | 38.6% | 0.71 | -$8.26 | -14.54% | 17.00% |
| Spread + commission + slippage | 178 | 37.6% | 0.68 | -$9.28 | -16.52% | 18.93% |

Convention: `commissionPerLot: 7` is round-turn and charged once at close. Slippage is adverse on market entry and stop/end market exits; TP is treated as a resting limit fill.

## Trailing Comparison

| Setting | Trades | Win rate | PF | Avg win | Avg loss | Return | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|
| Enabled | 178 | 37.6% | 0.68 | $52.19 | $46.38 | -16.52% | 18.93% |
| Disabled | 178 | 37.6% | 0.67 | $51.76 | $46.35 | -16.76% | 19.17% |

There were 15 break-even exits, 1 ATR-trailing exit, 111 full SL exits, and 51 TP exits. Performance did not collapse because of corrected trailing logic.

## Same-Bar Ambiguity

- Both SL and TP touched: **5 trades (2.81%)**
- Stop-first result: **-$1,651.62 total, -16.52%**
- TP-first result: **-$1,286.93 total, -12.87%**
- TP-first net effect: **+$364.69**

No date-addressable M1/tick endpoint exists for the historical ambiguous bars, so their true intrabar sequence remains unverified. Stop-first is retained and explicitly reported, not silently assumed.

## Walk-Forward Validation

| Fold | Trades | Return | PF | Win rate | Max DD |
|---|---:|---:|---:|---:|---:|
| 1 | 40 | -4.46% | 0.63 | 40.0% | 7.20% |
| 2 | 46 | -8.96% | 0.45 | 28.3% | 9.13% |
| 3 | 47 | -1.81% | 0.87 | 42.6% | 3.88% |
| 4 | 45 | -2.22% | 0.84 | 40.0% | 5.37% |

Total fold trades equal the standard run: **178**.

## Entry Ablations

| Configuration | Trades | Win rate | PF | Expectancy | Return | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| Trend alignment only | 224 | 37.5% | 0.74 | -$7.68 | -17.20% | 19.76% |
| Trend + RSI | 2 | 0.0% | 0.00 | -$49.86 | -1.00% | 1.00% |
| Trend + MACD | 26 | 42.3% | 1.07 | +$2.18 | +0.57% | 3.26% |
| Trend + candle patterns | 55 | 47.3% | 0.99 | -$0.33 | -0.18% | 4.27% |
| Trend + RSI + MACD | 27 | 40.7% | 1.01 | +$0.21 | +0.06% | 3.27% |
| Full, confidence threshold removed | 178 | 37.6% | 0.68 | -$9.28 | -16.52% | 18.93% |
| Full, trailing disabled | 178 | 37.6% | 0.67 | -$9.42 | -16.76% | 19.17% |
| Full, zero costs | 177 | 45.2% | 0.98 | -$0.48 | -0.85% | 9.04% |
| Full, realistic costs | 178 | 37.6% | 0.68 | -$9.28 | -16.52% | 18.93% |
| Reversed directions diagnostic | 185 | 38.4% | 0.75 | -$7.53 | -13.93% | 16.43% |

The confidence-threshold ablation is identical because `minConfidence` is the live AI confidence gate. Historical AI decisions are not available and are not fabricated. The small positive subset ablations are diagnostics only and do not satisfy the requested PF > 1.2 or robust OOS criteria.

## Independent 20-Trade Validation

Ten profitable/break-even and ten losing trades were selected across the full period. Independent RSI, MACD, signal line, ATR, entry, stop, target, lot size, commission, and P/L calculations matched the ledger.

- Discrepancies: **0/20**
- All entry index differences: **exactly one next H1 bar**
- Maximum entry difference: **2.22e-16**
- Maximum gross/net P/L difference: **8.64e-12**

Selected signal times:

`2025-06-11`, `2025-07-14`, `2025-08-29`, `2025-10-22`, `2025-12-04`, `2026-01-08`, `2026-02-17`, `2026-03-13`, `2026-04-28`, `2026-06-11`, plus ten losing trades distributed from `2025-06-16` through `2026-06-11`.

The repeatable calculation and complete trade ledger are produced by `backend/scripts/audit-backtest.ts`.

## C. Implemented Fixes

- Added broker symbol metadata for points, digits, tick size/value, volume constraints, and stop level.
- Added chronological sorting, duplicate removal, completed-candle filtering, and H4 visibility controls.
- Switched production backtests to actual broker H4 candles.
- Implemented MACD and RSI crossings and directional pattern checks.
- Implemented pending next-bar execution and bid/ask OHLC semantics.
- Added exact risk sizing with floor-to-step volume rounding.
- Shared break-even/ATR trailing math between live and backtest paths.
- Added same-bar ambiguity tracking and comparison policy.
- Added full trade diagnostics, grouped metrics, JSON/CSV downloads, and final equity reconciliation.
- Added walk-forward warm-up without pre-window trades.
- Added persistent completed-bar live deduplication.
- Added mandatory strategy-validation live gate.

## D. Validation Commands

```bash
cd backend
WEB_SEARCH_API_KEY= npm test
npm run typecheck
npm run build
npx tsx scripts/audit-backtest.ts /private/tmp/mt5-backtest-audit-final.json EURUSD

cd ../frontend
npm run build
```

## E. Safety Rule

Live trading remains blocked by `STRATEGY_VALIDATION_APPROVED=false`, even though the local general live-trading flag was enabled.

It must not be approved because:

- Out-of-sample performance is negative in all four folds.
- Realistic-cost profit factor is 0.68, below 1.2.
- The corrected strategy is negative even before costs.
- Historical AI/news behavior and tick-level ambiguous-bar order remain unavailable.

Do not enable live execution from these results.
