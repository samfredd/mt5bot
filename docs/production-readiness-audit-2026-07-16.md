# MT5 Bot Production-Readiness Audit

**Audit date:** 2026-07-16  
**Audited repository:** `/Users/samfred/Documents/business-projects/mt5 bot`  
**Current classification:** **Backtest-ready only**  
**Real-money verdict:** **Do not deploy with live funds**

## Remediation update — 2026-07-16 evening

The following engineering blockers identified below have now been remediated and verified in the running Docker stack:

- durable pre-submit `OrderIntent` records, client order IDs, uncertain-outcome recovery, and per-account market reservations;
- explicit placed/partial/filled/rejected/unknown execution states and requested/filled volumes;
- expected-account fencing plus serialized bridge account/order/modify/close mutations;
- bot-position ownership using magic/comment instead of automatic adoption of external positions;
- independent five-second protection/reconciliation worker;
- PostgreSQL-authoritative bot state, preventing stale Redis resurrection;
- durable retrying emergency flatten jobs with residual-position incidents;
- authenticated WebSocket upgrades;
- broker `order_check`, volume-step flooring, tick-size normalization, and full net P/L economics (profit, commission, swap, fee);
- scheduled approval expiry and removal of rejected-holdout feedback from Strategy Lab generation.

The conservative live-money verdict remains unchanged. Engineering safeguards cannot prove profitability, eliminate broker/platform outages, or replace forward validation on the exact broker/account. The single-terminal design also cannot operate multiple MT5 accounts simultaneously; it safely fences account switches but requires one isolated terminal/bridge per concurrently traded account.

This report covers the complete repository as it existed at the start of the audit, plus the status of the narrow safety patch applied after the audit. Findings marked **fixed in this audit** were verified after implementation. All other Critical and High findings remain release blockers.

The worktree already contained user changes before the audit, including an unfinished AI decision-context refactor in the trading service/scanner and untracked analysis modules. Those changes were preserved. The initial tree had no `.mq5`, `.mqh`, `.ex5`, `.set`, or native Expert Advisor entry point.

---

## 1. Executive summary

### Decision

The system is **Backtest-ready only**, in the limited sense that it can run deterministic research tests and the current TypeScript/Python test suites. It is not yet a trustworthy broker-connected demo system and is not suitable for limited-live or production trading.

The repository is a substantial trading platform, but it is not a native MQL5 EA. It is a Next.js control plane, Fastify/TypeScript trading backend, PostgreSQL/Redis state layer, and Python FastAPI bridge to a single MetaTrader 5 terminal. Therefore, native EA lifecycle items such as `OnInit`, `OnTick`, `OnTimer`, `OnTradeTransaction`, indicator handles, and `CopyBuffer` do not exist. Their closest equivalents are backend startup, scheduled workers, HTTP polling, and broker-history reconciliation.

### Why live trading is blocked

The decisive blockers are not cosmetic:

1. A broker order is sent before a durable execution intent exists. A fill followed by an HTTP/database failure can create an orphaned position and a duplicate retry.
2. IOC is preferred, but partial and asynchronous broker outcomes are not modeled correctly.
3. One global MT5 terminal can be switched between accounts while evaluation or submission is in flight.
4. The position manager deliberately adopts and modifies every untracked/manual/other-EA position.
5. Netting accounts can map multiple database trades to one broker position, making P/L attribution ambiguous.
6. Slow AI/new-trade work shares a mutex with reconciliation and capital-protection work.
7. Redis can override newer PostgreSQL bot state after restart, and emergency flatten is not a durable retrying workflow.
8. The WebSocket feed is unauthenticated and globally broadcasts trade/audit/notification data.
9. Broker volume, price, stop, freeze, margin, and symbol-trade constraints are not checked consistently before order submission.
10. The Strategy Lab feeds prior “out-of-sample” failures back into later hypothesis generation, invalidating repeated OOS claims.

### What was fixed after the audit

Only narrow, unambiguous safeguards were changed:

- completed the interrupted scanner `DecisionContext` migration and bounded AI SL/TP refinements;
- made scalping pass the global risk/live gate after its own risk gate;
- restored the declared live strategy-certification gate and enforced saved-account verification;
- enforced the configured per-trade risk maximum exactly, added finite-value checks, and rejected wrong-side take-profits;
- counted closed trades against daily global/copy trade caps;
- made approval claiming single-winner, enforced approval ownership, and carried per-action 2FA proof into approval-time risk validation;
- copied `filling.py` into both bridge Docker images;
- added regression tests for those behaviors.

These changes reduce immediate risk but do not solve durable order idempotency, broker normalization, account isolation, partial fills, restart fencing, manual-position ownership, WebSocket security, or backtest leakage. The live certification flag must remain `false`.

### Profitability statement

No profitability claim is supported. The existing forensic report records a corrected realistic result of approximately **-16.52% net return, 0.68 profit factor, 178 trades, and 18.93% maximum drawdown**, with zero-cost performance still negative and 0/4 profitable walk-forward slices (`docs/backtest-forensic-audit-2026-06-15.md:3-17,279-290`). That historical report was inspected but could not be independently reproduced during this audit because no bridge was running at `localhost:5001`.

---

## 2. System architecture

### 2.1 Repository map

```text
Next.js dashboard
  | REST + Bearer JWT
  | WebSocket (currently unauthenticated/global)
  v
Fastify / TypeScript backend
  |-- auth, users, strategies, scanner, scalping, copy trading
  |-- deterministic analysis + AI decision context
  |-- global risk engine
  |-- scheduler, reconciliation, position manager, incidents
  |-- PostgreSQL / Prisma (durable records)
  |-- Redis (leases, cache/mirror, coordination)
  |-- news, RSS, web search, Ollama/cloud AI
  |-- Telegram and Twilio WhatsApp controls
  v
TypeScript MT5 HTTP client
  | X-API-Key, read retries/circuit breaker, direct writes
  v
Python FastAPI MT5 bridge
  |-- in-memory mock broker, or
  |-- official MetaTrader5 Python package
  v
One MetaTrader 5 terminal / one currently connected account
```

### 2.2 Native MQL5 lifecycle mapping

| Requested EA concept | Repository equivalent | Status |
|---|---|---|
| `OnInit` | Fastify startup and `startWorkers()` in `backend/src/index.ts:41-130` | Implemented, not native EA |
| `OnTick` | One-minute strategy/scanner cycle and separate one-second scalping loop in `backend/src/workers/scheduler.ts:24-31,129-179` and `scalping.worker.ts:73-127` | Partial approximation |
| `OnTimer` | Node `setInterval` workers | Implemented |
| `OnTradeTransaction` | Poll `positions()` and `history()` in `trading/reconciliation.ts:14-180` | Missing event-driven equivalent |
| Indicator handles / `CopyBuffer` | TypeScript calculations over fetched candle arrays | Not applicable |
| EA magic-number filtering | Bridge sends magic `770077`, but returned positions omit magic/comment | Present but defective |
| Terminal restart state | PostgreSQL/Redis settings plus polling reconciliation | Partial |

### 2.3 Main execution paths

#### Configured strategy

`scheduler lease -> tick/candles -> completed-bar normalization -> durable bar checkpoint -> deterministic analysis -> news -> strategy signal -> AI veto -> bounded levels -> size -> global risk -> manual/semi/auto/paper -> broker -> DB -> position management -> reconciliation`

Evidence: `backend/src/workers/scheduler.ts:102-137`, `backend/src/modules/trading/service.ts:43-324`, `:326-415`, `backend/src/modules/trading/manager.ts:22-130`, and `backend/src/modules/trading/reconciliation.ts:14-180`.

#### Autonomous scanner

`M15/H1/H4 completed candles -> confluence score -> news -> deterministic DecisionContext -> AI strict/advisory gate -> bounded AI levels -> size -> global risk -> broker/paper/approval`

The previously stale four-argument prompt call was replaced with the current decision-context contract at `backend/src/modules/trading/scanner.ts:308-415`.

#### Scalping

`15-second AI/technical plan -> one-second scalping gate -> global news/risk/live gate -> broker -> one-second money/point exit manager`

After the safety patch, both gates must pass (`backend/src/modules/scalping/scalping.service.ts:28-40,340-421`). Paper-forward and day-cutoff semantics are still not centralized at the final broker boundary.

#### Manual, approval, and copy

- Manual REST trades call the global risk engine before `executeTrade`.
- Semi-auto approvals re-fetch tick/account/news and re-run risk.
- Copy signals run source rules and global risk, then call the same broker helper.
- `executeTrade` itself checks Redis availability but does **not** independently rebuild every invariant, so call-path consistency still matters.

### 2.4 State model

| State | Storage | Restart behavior |
|---|---|---|
| Users, accounts, strategies, trades, approvals, risk settings | PostgreSQL/Prisma | Durable |
| Strategy last processed bar | PostgreSQL `SystemSetting` | Durable duplicate guard |
| Bot state | Process cache, Redis mirror, PostgreSQL setting | Redis is read first; stale-state risk |
| Scanner cadence | Process `lastScanAt` | Resets; immediate post-restart scan possible |
| Scalping config | PostgreSQL | Durable |
| Scalping AI plans | Process memory | Rebuilt after restart |
| Mock positions/balance/deals | Python process memory | Lost on bridge restart |
| Real MT5 positions | Terminal/broker | Persist independently of backend records |

---

## 3. Implemented functionality

| Capability | Classification | Evidence / limitation |
|---|---|---|
| Fastify backend and Next.js dashboard | Fully implemented | Builds and tests pass |
| PostgreSQL schema/migrations and Redis coordination | Implemented | State precedence and infrastructure security defective |
| Mock and real Python MT5 adapters | Partially implemented | Real broker not exercised; fill/normalization gaps |
| Multi-timeframe deterministic indicators/signals | Implemented | Completed-bar path is sound; strategy assumptions remain |
| AI veto/decision context | Implemented | External latency can delay protection; scanner migration fixed |
| Manual, semi-auto, auto, copy, scanner, scalping modes | Implemented | Semantics differ between paths; final invariant gate not centralized |
| Stop-loss, take-profit, break-even, ATR trailing, time exit | Implemented | Manual positions are adopted; broker digits/freeze constraints missing |
| Risk-per-trade sizing | Implemented with limitations | Broker metadata path is sound; fallbacks and minimum/step edge cases remain |
| Daily/weekly loss, drawdown, streak, exposure limits | Partially implemented | Realized P/L excludes costs; no margin/free-margin gate |
| Live strategy/account gates | Fixed as coarse hotfix | Environment-wide flag, not per-strategy immutable certification |
| Approval ownership and single-winner claim | Fixed | Durable broker idempotency still missing |
| Broker reconciliation | Partially implemented | Polling, seven-day window, ambiguous netting, incomplete economics |
| Emergency stop/equity guardian/news/day flatten | Present but defective | Account-wide, non-durable, residual-position risk |
| Backtester, sensitivity, OOS slices, Monte Carlo | Implemented for research | Execution simplifications and data leakage prevent production inference |
| Structured logging, audit, errors, incidents | Partially implemented | No metrics/tracing/SLO/external paging; audit can fail open |
| Telegram and WhatsApp controls | Implemented | Connector RBAC incomplete; ownership hotfix added to approvals |
| Authenticated/scoped WebSocket | Missing | Current feed is global and unauthenticated |
| Email delivery | Missing | SMTP config exists, notification fan-out does not implement it |
| Native MQL5 EA files and lifecycle | Missing / not applicable | This is an external platform, not an EA |
| Pending orders, expiry/cancel, partial close state machine | Missing | Market orders only; approval expiry is on-demand |
| Real bridge Compose service/Wine volume | Missing | `Dockerfile.real` exists but Compose has no real profile service |

---

## 4. Critical issues

### 4.1 Critical — broker side effect precedes durable intent

- **Status:** unresolved release blocker.
- **References:** `backend/src/modules/trading/service.ts:326-380`; `backend/src/modules/mt5/client.ts:177-197,270-281`.
- **Code path:** every strategy/scanner/manual/copy/scalp order eventually calls `executeTrade`, which calls MT5 before creating/updating the durable trade record.
- **Why it matters:** an accepted order followed by an HTTP timeout, process crash, account-ID lookup failure, or database error leaves a real position without an authoritative execution record.
- **Failure scenario:** MT5 fills a long; the 15-second HTTP response is lost; the caller sees an error and retries; a second long is opened while risk/symbol guards remain blind to the first.
- **Correction:** create an immutable `OrderIntent`/`SUBMITTING` record first, use a unique client order ID in the broker comment, model `UNKNOWN`, and reconcile that ID before retry. Serialize per-account submission and make the final state transition transactional.

### 4.2 Critical — partial/asynchronous order results are misclassified

- **Status:** unresolved release blocker.
- **References:** `mt5-bridge/filling.py:5-14`; `mt5-bridge/main.py:407-446,462-481`.
- **Code path:** bridge prefers IOC, then accepts only `TRADE_RETCODE_DONE` as success.
- **Why it matters:** `DONE_PARTIAL` can create exposure even while the application records failure; `PLACED` is non-terminal. Executed volume is not returned.
- **Failure scenario:** a 1.0-lot IOC order fills 0.4 lot and returns partial; the backend records `FAILED`; the live 0.4 position is later adopted as “manual” or duplicated.
- **Correction:** model `SUBMITTED`, `PLACED`, `PARTIALLY_FILLED`, `FILLED`, `REJECTED`, `UNKNOWN`; return requested/filled volume, order/deal/position IDs, retcode, external retcode, and comment; poll/reconcile to terminal state. MetaQuotes explicitly distinguishes `DONE`, `DONE_PARTIAL`, and `PLACED` in the [official trade return codes](https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes).

### 4.3 Critical — account switch and order submission race

- **Status:** unresolved release blocker.
- **References:** `backend/src/modules/mt5/routes.ts:30-76`; `backend/src/modules/trading/service.ts:349-369`; `mt5-bridge/main.py:274-315,565-600`.
- **Code path:** risk can be evaluated for account A while the single global terminal is switched to account B; account ID is read again only after submission.
- **Why it matters:** sizing/live authorization can use one balance/account while the order lands on another.
- **Failure scenario:** a long login call outlives the backend timeout and switches the terminal just before an automated order; the order is evaluated for a demo account but executes on a real account.
- **Correction:** one isolated bridge per account, or a distributed fencing lock covering evaluate-finalize, connect, order, modify, and close. Include expected and executed login/server/margin mode in every broker response.

### 4.4 Critical — global unauthenticated WebSocket and incomplete connector RBAC

- **Status:** partly mitigated; unresolved release blocker.
- **References:** `backend/src/index.ts:77`; `backend/src/modules/ws/hub.ts:3-15`; `backend/src/modules/telegram/bot.ts:26-45,142-168`; `backend/src/modules/whatsapp/routes.ts:48-64,115-137`.
- **Code path:** every socket receives all broadcast events; linked connector users are not consistently role-gated.
- **Why it matters:** trade IDs, audit details, notifications, incidents, P/L, and control state leak across users. Before the patch, leaked IDs could be decided cross-user.
- **Failure scenario:** an unauthenticated client reads an approval ID and operational data; a linked low-privilege connector user attempts account-wide commands.
- **Correction:** authenticate the upgrade, associate sockets with `userId` and role, publish only scoped events, and enforce one service-level RBAC policy for REST/Telegram/WhatsApp. Approval ownership is now checked at `trading/service.ts:424-459`, but the feed and broader controls remain unsafe.

### 4.5 Critical — external/manual positions are automatically adopted and modified

- **Status:** unresolved; explicit design choice with unsafe default.
- **References:** `backend/src/modules/trading/manager.ts:31-47,69-129,133-168`; `mt5-bridge/main.py:393-405`.
- **Code path:** every untracked terminal position becomes a bot `MANUAL` trade and trailing defaults to enabled. Position payloads omit magic/comment.
- **Why it matters:** the bot cannot isolate its positions from human or other-EA positions and can ratchet their stops or time-close them.
- **Failure scenario:** a discretionary gold trade on a shared account is adopted and its SL is moved based on this platform's ATR rules.
- **Correction:** return magic/comment/reason/account from MT5; manage only the configured magic and client IDs; account-scope DB lookups; make external adoption explicit per position. Keep emergency account-wide flatten as a separately named, strongly confirmed action.

### 4.6 Critical — slow analysis can suspend capital protection

- **Status:** unresolved release blocker.
- **References:** `backend/src/workers/scheduler.ts:30,38-143`; `backend/src/workers/scheduler-cycle.ts:1-8`; `backend/src/modules/ai/providers/openai-compatible.ts:43-56`.
- **Code path:** one `running` flag covers protective work followed by sequential scanner/strategy/AI work; later minute ticks return while it remains set.
- **Why it matters:** a slow provider or many symbols can suppress position management, equity guardian, day exit, and reconciliation for minutes.
- **Failure scenario:** three 60-second AI attempts hold the cycle while a position crosses the equity floor; the guardian does not run on the skipped ticks.
- **Correction:** independent protection and research workers, separate non-overlap locks, hard deadlines, and a protection heartbeat/SLO. New-trade latency must never gate exit/reconciliation cadence.

### 4.7 Critical — restart can resurrect stale bot state

- **Status:** unresolved release blocker.
- **References:** `backend/src/modules/system/state.ts:35-64`; `backend/src/tests/operational-state.test.ts:76-86`.
- **Code path:** a cold process reads Redis before PostgreSQL; Redis mirror write failure is ignored; process cache has no TTL or cross-instance invalidation.
- **Why it matters:** a newer durable pause/emergency state can be replaced by stale `running`/live state after restart.
- **Failure scenario:** emergency stop persists in PostgreSQL but Redis retains an earlier running state; restart reads Redis and resumes evaluations.
- **Correction:** PostgreSQL-authoritative monotonic version/CAS, version-matched Redis cache, pub/sub invalidation or bounded TTL, and a startup fail-closed re-arm policy.

### 4.8 Critical — emergency flatten is not durable or retrying

- **Status:** unresolved release blocker.
- **References:** `backend/src/modules/trading/service.ts:615-627`; `backend/src/workers/scheduler.ts:47-99`.
- **Code path:** emergency state is set, then positions are closed sequentially without per-position exception containment or persistent flatten intent. Protective management is skipped under emergency.
- **Why it matters:** one exception can abort the loop and leave residual positions unmanaged indefinitely.
- **Failure scenario:** the first close succeeds, the second throws on a transient disconnect, and the remaining positions stay open while the system reports emergency mode.
- **Correction:** persist a flatten job, close each owned/all-confirmed position independently, retry with reconciliation until zero remain, and raise external critical alerts for residual tickets.

### 4.9 Critical — netting behavior breaks trade ownership and P/L attribution

- **Status:** unresolved release blocker.
- **References:** `backend/src/modules/trading/symbol-lock.ts:11-42`; `backend/prisma/schema.prisma:256-264`; `backend/src/modules/trading/reconciliation.ts:79-110`.
- **Code path:** same-strategy and alternate-path entries may share a symbol; a netting broker merges them into one position ID; reconciliation excludes per-trade P/L when multiple DB trades share it.
- **Why it matters:** loss limits, performance statistics, close ownership, and strategy attribution become unreliable.
- **Failure scenario:** scanner and scalp both buy the broker alias for gold; one net position is later closed; both DB trades receive null P/L and loss controls are blind.
- **Correction:** expose account margin mode. For netting, enforce one canonical-symbol owner/order stream or implement deal-level allocation. Canonicalize aliases/suffixes before locks, risk, and persistence. See MetaQuotes [account properties](https://www.mql5.com/en/docs/constants/environment_state/accountinformation) and [position data](https://www.mql5.com/en/docs/python_metatrader5/mt5positionsget_py).

### 4.10 High — broker constraints are not enforced consistently

- **Status:** unresolved release blocker.
- **References:** `backend/src/modules/risk/engine.ts:96-152`; `mt5-bridge/main.py:357-370,407-425`; `backend/src/modules/trading/manager.ts:115-129`.
- **Code path:** normal/manual/copy/scanner proposals can use raw fixed/approved lots and raw SL/TP; bridge does not normalize or call `order_check`.
- **Why it matters:** volume-step, tick-size, digits, stop-level, freeze-level, symbol trade mode, and margin restrictions differ across brokers and CFDs.
- **Failure scenario:** a broker uses 0.25 volume steps; rounding produces 0.8 from 0.75, or an SL inside the stops/freeze level is repeatedly rejected.
- **Correction:** fetch fresh symbol/account metadata at the final boundary; floor volume to step; normalize prices to tick size/digits; enforce stops/freeze and trade mode; run `order_check`/`order_calc_margin`; retain the full result. Official references: [symbol properties](https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants), [OrderCheck](https://www.mql5.com/en/docs/trading/ordercheck), and [Python integration functions](https://www.mql5.com/en/docs/python_metatrader5).

### 4.11 High — realized P/L and loss controls omit trading economics

- **Status:** unresolved release blocker.
- **References:** `mt5-bridge/main.py:483-501`; `backend/src/modules/trading/reconciliation.ts:40-76,112-180`; `backend/src/modules/trading/service.ts:525-552`.
- **Code path:** bridge history exports `profit` but not commission, swap, or fee; reconciliation uses its own timestamp; daily/weekly windows use host-local boundaries.
- **Why it matters:** daily/weekly loss, loss streak, expectancy, and strategy attribution can materially understate losses or shift them to the wrong day.
- **Failure scenario:** gross deal profit is +$5 but commission/swap is -$12; the system records a win and resets the losing-streak breaker.
- **Correction:** ingest full deal economics/timestamps and entry/exit types; calculate net realized P/L; use explicit UTC/broker-session boundaries and start-of-period equity; extend history over the full position lifetime.

### 4.12 Critical — Strategy Lab leaks repeated OOS feedback

- **Status:** unresolved statistical release blocker.
- **References:** `backend/src/modules/strategy/lab.ts:166-174,191-192,320-361`.
- **Code path:** rejected validation reasons from prior runs are added to future AI hypothesis prompts, while the same final 20% is reused as “OOS.”
- **Why it matters:** the holdout becomes training feedback; repeated runs optimize against it even without explicit parameter search.
- **Failure scenario:** candidates gradually learn the rejection reasons of the final data slice and eventually pass a contaminated threshold that will not generalize.
- **Correction:** immutable one-use lockbox or nested walk-forward. Never feed lockbox outcomes into generation; hash and freeze data/config/engine artifacts.

### 4.13 High — news failure can become `allow`

- **Status:** unresolved.
- **References:** `backend/src/modules/news/service.ts:41-88,96-167`; `backend/src/modules/news/headlines.ts:107-128`.
- **Code path:** stale/empty calendar rows and failed headline AI can yield no blocking events without a freshness SLA.
- **Why it matters:** an integration failure is indistinguishable from a genuinely clear calendar.
- **Failure scenario:** calendar download fails before NFP; an empty query returns `allow`; entries open inside the intended blackout.
- **Correction:** persist last-success/freshness, expose a degraded state, and configure explicit fail-closed or reduced-risk policy when stale.

### 4.14 Critical — bridge/infrastructure authentication is unsafe by default

- **Status:** unresolved release blocker.
- **References:** `backend/src/config.ts:27,67-83`; `mt5-bridge/main.py:34-42`; `docker-compose.yml:2-25,34-56`.
- **Code path:** empty bridge key can authenticate an empty header; bridge/Postgres/Redis are published; Redis has no ACL/password and Postgres has a default password fallback.
- **Why it matters:** access to bridge endpoints permits orders/closes; Redis controls leases/state/revocation mirrors.
- **Failure scenario:** an unset Compose key becomes empty; a request with no header calls `/order` on a published bridge port.
- **Correction:** refuse blank/short/placeholder secrets, constant-time compare, private Docker network, loopback-only development binds, Redis ACL/TLS/password, strong required DB secret, and host firewall/TLS reverse proxy.

### 4.15 Critical — scalping bypassed global risk/live controls

- **Status:** **fixed in this audit for global risk/live/account/certification gates**; broader mode gaps remain.
- **References:** fixed path at `backend/src/modules/scalping/scalping.service.ts:28-40,204-248,340-421`; tests at `backend/src/tests/scalping-service.test.ts`.
- **Original path/problem:** scalping applied only its separate gate and called `executeTrade` directly, allowing global loss/exposure/live gates to be bypassed.
- **Failure scenario:** separate scalping status is running on a real terminal while global live trading is disabled; a scalp order is sent.
- **Correction applied:** load global risk settings, perform global news assessment, build a fresh global risk context, and require `validateTrade` before execution.
- **Remaining exposure:** paper-forward and day-trading cutoff are not final-boundary gates; canonical cross-engine symbol ownership and netting isolation remain unresolved.

### 4.16 Critical — live certification and verified-account gates were declared but absent

- **Status:** **coarse hotfix applied; production-grade certification unresolved**.
- **References:** `backend/src/modules/risk/engine.ts:26-88`; `backend/src/modules/trading/service.ts:530-606`; `backend/src/config.ts:16-18`.
- **Original path/problem:** `STRATEGY_VALIDATION_APPROVED` and `Mt5Account.verified` existed but were not consumed by live risk validation.
- **Failure scenario:** an enabled, unvalidated strategy executes after the other live toggles are opened.
- **Correction applied:** every live risk context now requires the independent environment flag and a verified saved account.
- **Remaining exposure:** certification is global, mutable, and not bound to strategy config hash, engine version, data hash, costs, broker spec, or expiry. Phase 2 must implement immutable per-strategy certification.

### 4.17 Critical — approval race and cross-user decision

- **Status:** **fixed in this audit for approval claiming/ownership**; general order idempotency unresolved.
- **References:** `backend/src/modules/trading/service.ts:424-510`; callers in `trading/routes.ts`, `telegram/bot.ts`, and `whatsapp/routes.ts`; tests in `trading-pipeline.test.ts`.
- **Original path/problem:** concurrent requests could both read `PENDING_APPROVAL` and submit, and the service did not verify the actor owned the trade.
- **Failure scenario:** double-click/chat retry submits two broker orders, or a connector acts on another user's leaked ID.
- **Correction applied:** owner ID is required; one conditional `PENDING_APPROVAL -> APPROVED/REJECTED` update claims the trade before broker I/O; only the winner proceeds; per-action 2FA proof is passed to the fresh risk context.
- **Remaining exposure:** a broker fill can still be unknown after timeout, because the general execution path lacks a durable idempotency ID/state machine.

### 4.18 High — stated risk cap, target direction, and daily counts were defective

- **Status:** **fixed in this audit for these exact defects**.
- **References:** `backend/src/modules/risk/engine.ts:96-146`; `backend/src/modules/trading/service.ts:536-552`; tests in `backend/src/tests/risk.test.ts`.
- **Original path/problem:** risk validation allowed 150% of the displayed maximum, accepted wrong-side TP via absolute distance, lacked explicit finite-value checks, and dropped closed trades from daily caps.
- **Failure scenario:** a configured 1% cap permits 1.2%; a buy TP below entry passes R:R; a fast strategy closes and recycles daily slots.
- **Correction applied:** exact cap with numeric epsilon only, finite positive input checks, directional TP validation, and `EXECUTED` plus `CLOSED` counts keyed by `openedAt`.
- **Remaining exposure:** daily reservations are not atomic; commission/swap P/L and broker-day boundaries remain wrong.

### 4.19 Critical availability — scanner/build and bridge Docker context were broken

- **Status:** **fixed in this audit**.
- **References:** `backend/src/modules/trading/scanner.ts:308-415`; `mt5-bridge/Dockerfile:1-7`; `mt5-bridge/Dockerfile.real:44-46`.
- **Original path/problem:** scanner called an obsolete prompt signature; both Dockerfiles omitted imported `filling.py`.
- **Failure scenario:** backend typecheck fails; bridge image exits with `ModuleNotFoundError: filling`.
- **Correction applied:** scanner now constructs the intended `DecisionContext`; both images copy `filling.py`. Backend/frontend builds, Python compile/tests, Compose validation, and Dockerfile static check pass.

---

## 5. Strategy-logic findings

### 5.1 Positive findings

- Configured strategies normalize candles and exclude the current incomplete bar using tick time.
- The normal strategy path persists a per-strategy/symbol completed-bar checkpoint, reducing repeat-on-restart risk.
- Technical signals are deterministic and use completed candles; no native repainting indicator or future `CopyBuffer` access exists.
- Long entries use ask; short entries use bid. Position management uses executable bid for longs and ask for shorts.
- AI can veto but cannot bypass deterministic risk.
- Engineered SL/TP values are directionally constructed from ATR; AI refinements are now clamped to correct-side bounded ATR ranges in strategy and scanner paths.

### 5.2 Defects and hidden assumptions

| Finding | Severity | Evidence / effect |
|---|---:|---|
| Scanner has no durable per-bar checkpoint | High | A persistent H1 setup can execute again on later 2-10 minute scans after the previous trade closes |
| Same-strategy entries can repeat/merge | High | `symbol-lock.ts:11-42`; dangerous on netting |
| Timeframe array order is semantic | Medium | First frame is primary and last is higher; schema does not enforce order/uniqueness |
| Confluence threshold is an absolute score | Medium | Adding filters does not proportionally raise the threshold |
| Asian range is fixed UTC | Medium | Broker/session/DST assumptions can diverge |
| Strategy live `maxTradesPerDay`/news behavior diverges from backtest config | High | Strategy config fields are not consistently consumed in live path |
| Signal/risk quote differs from broker quote | High | Absolute SL/TP and size can represent more risk after price drift |
| Approval expiry has no scheduled cleanup | High | Expired pending rows can occupy a symbol indefinitely |
| Copy parsed entry is discarded | High | A delayed signal is converted to immediate market execution without a drift bound |
| Day/paper semantics differ across alternate paths | High | Copy, directed scanner, approval, and scalping are not all gated at one final boundary |

### 5.3 Theoretical long trace

1. Scheduler obtains the new-trade lease and selects an enabled strategy/symbol.
2. Tick and timeframes are fetched; incomplete candles are removed; the newest completed primary bar is compared with the durable checkpoint.
3. Deterministic analysis scores bullish trend/structure, RSI/MACD/pattern confluence and derives a buy.
4. Entry is planned at ask; SL is below entry and TP above entry using ATR/config rules.
5. News is assessed; compact deterministic context is sent to AI. AI must agree with sufficient confidence.
6. AI levels are bounded; lots are recalculated from the actual chosen stop.
7. Global risk validates platform/live gates, SL/TP, exact monetary risk, exposure, loss/drawdown, spread, volatility, and session.
8. AUTO calls the bridge; the bridge fetches a fresh ask and sends a BUY market deal with magic `770077`.
9. At approximately +1R, manager moves SL toward break-even; beyond +1.5R it may trail one ATR.
10. Broker SL/TP or close removes the position; the next reconciliation poll sees it absent and attributes deal history.

**Gap:** if planned entry was 1.10000 with SL 1.09750 but actual fill is 1.10100, actual stop risk is 350 rather than 250 points—a 40% increase—with no post-fill resize/rejection.

### 5.4 Theoretical short trace

The path mirrors the long: bearish confluence creates a SELL; entry is planned at bid; SL is above and TP below; bridge sells at fresh bid; management measures executable price at ask, moves break-even below entry, and trails at ask + ATR. Reconciliation itself is direction-agnostic.

### 5.5 Strategy correctness conclusion

The core configured strategy is internally understandable and largely non-repainting, but live behavior is not yet equivalent to backtest behavior and duplicate/netting/session/execution assumptions remain. Correct code would still not make the strategy profitable; current repository evidence points the other way.

---

## 6. Risk-management findings

### 6.1 Independently verified sizing formula

When broker metadata is correct:

```text
riskAmount = balance * riskPercent / 100
riskPerLot = abs(entry - stopLoss) / tickSize * tickValue
rawLots = riskAmount / riskPerLot
lots = floor(rawLots to broker volumeStep), bounded by policy/broker maxima
```

#### EURUSD example

- Balance: $10,000; risk: 1% = $100.
- Entry 1.10000; SL 1.09750; distance 0.00250.
- Tick size 0.00001; tick value $1 per lot: 250 ticks × $1 = $250 risk per lot.
- Size: $100 / $250 = **0.40 lot**.

#### XAUUSD example

- Balance: $10,000; risk: 1% = $100.
- Entry 2350; SL 2345; distance $5.
- Tick size $0.01; tick value $1 per lot: 500 ticks × $1 = $500 risk per lot.
- Size: $100 / $500 = **0.20 lot**.

#### USDJPY example

- Balance: $100,000; risk: 1% = $1,000.
- Entry approximately 151; stop distance 0.300.
- Tick size 0.001; broker/account-currency tick value approximately $0.66: 300 × $0.66 ≈ $198 per lot.
- Size: about **5.05 lots** before configured/broker caps.

Actual broker tick value in the account currency must be used. Static fallback currency/contract assumptions are not acceptable as production evidence for crosses, metals, indices, crypto, or CFDs.

### 6.2 Fixed risk defects

- Per-trade `maxRiskPerTradePct` is now a hard maximum, not a hidden 1.5× allowance.
- Entry/lots/SL/TP receive explicit finite/positive validation.
- TP must be on the profitable side of entry.
- Closed trades continue consuming the daily slot.
- Live validation now also requires strategy certification and verified account.
- Scalping now passes the global risk gate.

### 6.3 Remaining risk defects

1. No `order_calc_margin`, free-margin minimum, leverage cap, or margin-level gate.
2. Exposure uses inferred static contracts and approximate currency conversion, not broker-native per-position/account-currency risk.
3. Copy exposure compares lots across unlike instruments.
4. Minimum lot can exceed the requested risk budget; invalid metadata can fall back to a minimum lot instead of producing a sizing error.
5. Decimal handling assumes power-of-ten volume steps; 0.25-style steps can be normalized incorrectly.
6. News `reduce` halves to a two-decimal value without broker step/minimum revalidation.
7. Daily/weekly P/L excludes commission, swap, and fees and uses host-local boundaries/current balance rather than start-period equity.
8. Peak equity is sampled when risk context is built, so interim peaks can be missed.
9. Symbol exposure compares exact names; suffix/alias variants can evade per-symbol counts.
10. Fixed-lot proposals and human-selected lots are not normalized to live broker metadata at the final boundary.
11. Emergency/equity/day/news flatten behavior is intentionally account-wide, which is unsafe on a shared account.

---

## 7. Execution and broker-compatibility findings

### 7.1 Account modes

- Hedging can hold multiple positions, but database ownership still needs durable client IDs.
- Netting is unsafe because multiple logical trades may share one position ID and P/L becomes ambiguous.
- Account margin mode is not returned or used, so the system cannot select an explicit policy.

### 7.2 Filling and result codes

`select_filling_mode` uses symbol flags and avoids `RETURN` for market execution, which is directionally sensible. However, only `DONE` is accepted. MetaQuotes documents filling-policy restrictions and position/order fields in [order properties](https://www.mql5.com/en/docs/constants/tradingconstants/orderproperties), and warns that a successful `OrderSend` call is not proof that execution has completed in [OrderSend](https://www.mql5.com/en/docs/trading/ordersend).

### 7.3 Constraint coverage

| Broker concern | Current state |
|---|---|
| Magic number | Sent as `770077`; not returned/filtered on positions |
| Broker symbol suffix/alias | Resolver exists; canonical locks remain incomplete |
| Volume min/max | Metadata available; not enforced on every fixed/manual path |
| Volume step | Risk-based sizing floors common steps; final order not normalized |
| Tick size/digits | Metadata available; manager guesses digits; final stops not normalized |
| Stops level | Exposed; used by scalp stops only, not every path |
| Freeze level | Not exposed or enforced |
| Symbol trade mode | Not exposed or enforced |
| Slippage/deviation | Fixed 20 points; not configurable or symbol-scaled |
| `order_check` / margin | Missing |
| Partial fills | Misclassified |
| Partial closes | No durable model |
| Pending orders/expiry | Not implemented; only market deals and app approvals |
| Closed market/no price | Errors surface, but no explicit market-session/trade-mode precheck |

### 7.4 Required execution record

| Required field | Current durable coverage |
|---|---|
| Function return | Yes, partial |
| Trade retcode | Audit result only; not unified in `Trade.explanation` |
| Broker rejection reason | Basic comment/error; modify/close often use `last_error()` |
| Requested price | Proposal/execution comparison |
| Executed price | Stored if returned |
| Requested/executed volume | Requested only; executed volume missing |
| SL/TP | Stored |
| Spread | Some comparison/audit fields |
| Signal identifier | Strategy/AI IDs partially; broker comment generic |
| Requested/filled timestamps | Execution comparison only, not unified state machine |
| Order/deal/position IDs | Order/position partially; deal missing |
| Executing account/server | Read separately after order; raceable |

---

## 8. Reliability findings

### 8.1 Idempotency verdict

The system is **not idempotent** end to end.

- Configured strategy completed-bar checkpoint: durable and helpful.
- Approval click/retry: single-winner claim fixed.
- Scanner same-bar/cadence: not durable.
- Copy source reference: not unique; webhook/chat replay can duplicate.
- Broker request: no durable client ID or unknown-outcome reconciliation.
- Lease renewal: lost renewal does not cancel/fence work.
- Restart: scanner runs immediately; mock broker state disappears; normal protection waits up to 60 seconds.

### 8.2 Failure-mode assessment

| Failure | Behavior | Assessment |
|---|---|---|
| Backend restart | Reloads persisted running state and restarts workers | Unsafe auto-resume; no immediate full reconciliation |
| VPS/bridge restart | Real broker positions persist; mock state is lost | Partial recovery only |
| Internet/broker disconnect | Reads retry/circuit; writes not retried | Correct not to blindly retry, but unknown outcome is unresolved |
| Missing tick/closed market | Calls fail/skip | No durable retry policy or explicit trade-mode precheck |
| Weekend/price gap | Live broker decides; backtest fills stop at stop price | Backtest understates adverse gap fills |
| High spread/ATR | Global risk can block | Good, assuming fresh/context path |
| AI downtime | Strategy strict path stops; scanner configurable | Safe for entries, but latency can delay protection |
| News/API downtime | Cached/stale data can allow | Freshness/fail policy missing |
| Redis downtime | New orders fail closed | Good; protective work does not require lease |
| PostgreSQL/audit failure | Broker call can happen before durable record; audit errors swallowed | Critical |
| Emergency close failure | Loop can abort; no retry intent | Critical |
| Graceful shutdown | Clears timers, does not await all in-flight work before exit | High |
| File corruption | No dedicated integrity/hash/backup workflow beyond DB/tool defaults | Missing |
| Memory/log growth | In-process maps mostly bounded/limited, but DB logs/prompts have no retention | Medium |

### 8.3 Recovery requirements

Before any broker-connected demo, startup must: default paused, identify the exact terminal account/margin mode, reconcile open positions and unknown order intents, re-establish owned-position mappings, expire stale approvals, validate news freshness, verify Redis/Postgres version agreement, then require operator re-arm.

---

## 9. Backtesting-validity findings

### 9.1 What can be trusted

- Deterministic output for one exact candle/config/instrument snapshot.
- Completed-bar filtering and chronological deduplication.
- Next-bar entry rather than same-bar look-ahead.
- Bid/ask spread treatment, configured commission/slippage, and a conservative stop-first same-bar policy.
- Relative debugging comparisons where all simplifications are held constant.

### 9.2 What cannot be trusted for capital allocation

1. Repeated OOS data is leaked back into hypothesis generation.
2. “Walk-forward” scores a fixed strategy across slices; it does not fit/select on each training window and test the next untouched window.
3. Monte Carlo IID-resamples fixed nominal P/L, ignoring serial dependence, regimes, dynamic sizing, variable costs, gaps, margin, and ruin.
4. Fixed spread/slippage/commission omit variable spread, latency, rejects, partial fills, liquidity, and swap.
5. Gap-through-stop fills at the stop rather than the worse opening price.
6. Maximum drawdown uses bar-close equity and can miss intrabar adverse excursion.
7. Portfolio validation averages independent symbol runs instead of simulating shared capital, concurrency, correlation, and margin.
8. OOS thresholds permit small samples (for example 20 trades and PF 1.1).
9. Validation records do not fully bind data hash/source, engine commit, strategy/cost config, or broker metadata.
10. Survivorship/universe changes and broker symbol history are not addressed.

### 9.3 Existing result interpretation

The existing forensic report is evidence that the tested strategy/config was unprofitable under its stated model—not proof of how future/live trading will behave. A high win rate is irrelevant if expectancy/profit factor after costs is negative.

### 9.4 Required validation plan

1. **Freeze data and hypotheses:** source, timezone, coverage, gaps, symbol mapping, broker metadata, costs, code commit, and config hash.
2. **In-sample development:** one training segment only; record every hypothesis and parameter search.
3. **Nested walk-forward:** fit/select only on each training window; test once on the next window; aggregate untouched folds.
4. **Final lockbox:** a never-before-seen final segment, one use only, no feedback into development.
5. **Sensitivity:** parameter surfaces, not single optima; require broad plateaus.
6. **Multi-symbol/timeframe:** synchronized portfolio simulation with shared equity, margin, correlation, and canonical symbols.
7. **Execution stress:** variable/percentile spread, slippage, latency, rejection, partial fill, gap, commission, swap, and worse-stop fills.
8. **Monte Carlo:** block/regime bootstrap in R-multiples with dynamic risk/equity, cost/gap stress, ruin and margin-call probabilities.
9. **Demo forward:** at least several market regimes and all restart/disconnect/news/gap scenarios.
10. **Small-capital canary:** only after all release blockers, with independent kill switch, strict loss budget, and no shared/manual positions.

### 9.5 Minimum metrics

- Net profit and return after all costs
- Profit factor and expectancy (money and R)
- Maximum balance/equity/intrabar drawdown
- Recovery factor
- Sharpe and Sortino, with sampling assumptions stated
- Win rate, average win/loss, payoff ratio
- Trade count and effective independent sample size
- Maximum/consecutive losses and time to recovery
- Time in market and gross/net exposure
- Margin utilization and ruin/margin-call probability
- Performance by symbol, session, direction, timeframe, volatility/trend regime, and calendar period
- Parameter stability and fold dispersion
- Expected versus actual spread, slippage, fill rate, rejection rate, and attribution rate

---

## 10. Code-quality findings

### Strengths

- Clear module boundaries for analysis, strategy, risk, execution client, persistence, notifications, and workers.
- Pure risk/indicator/backtest helpers are unit-testable.
- Central MT5 client and structured audit/error/incident services are good foundations.
- Zod validation is widely used.
- Completed-bar/checkpoint logic and circuit-breaker abstractions show deliberate reliability work.
- Final patched tree typechecks, builds, and passes the available tests.

### Weaknesses

- `executeTrade` is not a true invariant-enforcing execution engine; safety depends on each caller.
- Global singleton terminal/state means code that looks multi-user is operationally single-account.
- Large orchestration functions combine I/O, decisions, persistence, notification, and broker effects.
- Bot state has three authorities without versioning.
- Strategy, scanner, copy, and scalping duplicate mode/news/sizing/ownership semantics.
- Generic JSON `explanation` is flexible but cannot replace a typed execution state machine.
- Broker-specific normalization is split or absent.
- Comments/docs previously contradicted runtime behavior; one contradiction was corrected in `docs/TECHNICAL.md`.
- SMTP variables are dead configuration because email dispatch is absent.
- CI does not exercise real MT5, Postgres migrations, Redis loss, Docker restart, or end-to-end broker flows.

### Recommended architecture

Do not rewrite the entire product. Evolve toward these boundaries:

1. **Signal services:** strategy/scanner/scalp/copy produce immutable proposals only.
2. **Pre-trade policy service:** global live/account/day/paper/news/risk/margin/symbol ownership, with an atomic reservation.
3. **Execution state machine:** durable intent, unique client ID, broker adapter, terminal outcomes, reconciliation.
4. **Account-isolated bridge:** one account per instance or strict fencing.
5. **Position ownership/manager:** bot-owned positions only by default; explicit external adoption.
6. **Protection worker:** independent, deadline-bound exits/reconciliation/guardian.
7. **Research/validation service:** immutable data/config provenance and true nested OOS workflow.

---

## 11. Missing production safeguards

### P0 — must exist before broker-connected demo

- [ ] Durable order intent/client ID/unknown-outcome reconciliation
- [ ] Account switch/order fencing and explicit account margin mode
- [ ] Broker volume/tick/stops/freeze/trade-mode/margin validation
- [ ] Partial/asynchronous fill state machine
- [ ] Bot-position magic/comment ownership isolation
- [ ] Independent protection worker and startup reconciliation
- [ ] Durable retrying emergency flatten with residual-ticket alert
- [ ] PostgreSQL-authoritative versioned bot state and operator re-arm
- [ ] Authenticated, user-scoped WebSocket and connector RBAC
- [ ] Private/secured bridge, Redis, and PostgreSQL networking/secrets
- [ ] Canonical-symbol and netting policy

### P1 — before strategy validation can be trusted

- [ ] Full deal economics and timestamps
- [ ] Atomic per-account/symbol/daily reservations
- [ ] Margin/free-margin/leverage limits
- [ ] News freshness/degraded-state policy
- [ ] Copy source-reference uniqueness and entry-drift rules
- [ ] Scheduled approval expiry
- [ ] Unified paper/day/live behavior at final boundary
- [ ] Immutable per-strategy certification tied to hashes/version/broker/costs
- [ ] True nested walk-forward and untouched lockbox

### P2 — before controlled live rollout

- [ ] External metrics, tracing, alerts, and protection heartbeat
- [ ] Log/data retention, backup/restore, and audit integrity controls
- [ ] Demo chaos tests for restart/disconnect/gap/news/slow API
- [ ] Synchronized multi-symbol portfolio/margin simulation
- [ ] Long-duration demo-forward evidence and execution calibration
- [ ] Runbooks, on-call ownership, access review, and rollback procedure

---

## 12. Remediation roadmap

### Phase 1: Prevent catastrophic failures

1. Keep `STRATEGY_VALIDATION_APPROVED=false` and block all live deployments.
2. Build durable order-intent/idempotency and uncertain-fill reconciliation.
3. Fence account switching and broker mutations; isolate one account per bridge.
4. Model all broker outcomes and normalize/check every order.
5. Isolate bot positions by magic/client ID and define netting policy.
6. Separate protection, make emergency flatten retrying, and correct state authority.
7. Authenticate/scope WebSocket and secure infrastructure/secrets.

### Phase 2: Correct trading and risk logic

1. Add margin/free-margin/leverage and broker-native exposure calculations.
2. Correct lot-step/minimum-risk/news-reduction normalization.
3. Use net deal P/L including commission/swap/fee and broker timestamps.
4. Centralize day/paper/live/news/ownership gates for every path.
5. Add atomic daily/symbol/exposure reservations and copy replay protection.
6. Implement immutable per-strategy certification and invalidation on change.

### Phase 3: Improve reliability and observability

1. Startup paused reconciliation and explicit re-arm.
2. Protection heartbeat, scheduler lag, dependency latency, rejection/fill/attribution metrics.
3. External critical alerts and residual-position escalation.
4. Graceful draining of in-flight work, lease fencing, retention, backups, restore drills.
5. Integration tests with Postgres/Redis/mock bridge plus fault injection.

### Phase 4: Validate the strategy

1. Repair data-quality/gap/gap-fill/cost/margin assumptions.
2. Freeze provenance and hypotheses.
3. Run nested walk-forward, sensitivity, synchronized portfolio, and block/regime Monte Carlo.
4. Use a one-time final lockbox.
5. Require positive expectancy/profit factor after stressed costs, acceptable drawdown/ruin, and stable folds/regimes—not merely high win rate.

### Phase 5: Controlled production rollout

1. Dedicated demo account with broker-identical symbol specs and no manual/other-EA trades.
2. Long-duration forward test plus restart/disconnect/news/gap drills.
3. Independent review of execution logs versus broker statements.
4. Tiny-capital canary with strict total-loss budget and operator coverage.
5. Gradual scale only after objective gates; immediate rollback on reconciliation, attribution, latency, or loss-control breach.

---

## 13. Final production-readiness scorecard

Scores reflect the repository **after the narrow patch**, not the initial broken tree.

| Category | Score | Rationale |
|---|---:|---|
| Strategy correctness | 5/10 | Completed-bar deterministic core is reasonable; live/backtest and duplicate/session assumptions remain |
| Risk management | 5/10 | Exact cap/live/scalp gates improved; margin, costs, exposure, minimum/step and atomic reservation gaps remain |
| Trade execution | 2/10 | No durable intent/idempotency; partial/unknown outcomes and normalization unresolved |
| Broker compatibility | 2/10 | Single terminal, unknown margin mode, unsafe netting, missing freeze/trade-mode/margin checks |
| Error handling | 4/10 | Circuits/incidents exist; broker/database/emergency unknown states remain |
| Restart recovery | 2/10 | Some durable checkpoints/reconciliation; stale state, auto-resume, mock loss, no startup fencing |
| External integration reliability | 3/10 | Provider abstraction/circuits exist; slow AI and stale news affect safety cadence/decisions |
| Backtesting validity | 3/10 | Useful deterministic research engine; OOS leakage and unrealistic execution prevent allocation claims |
| Observability | 4/10 | Structured logs/audit/incidents; no metrics, tracing, SLO, external paging, or guaranteed audit |
| Security | 2/10 | JWT/RBAC/secret encryption foundations; public WS, weak infrastructure exposure, bootstrap/connectors remain |
| Maintainability | 6/10 | Modular and test-rich, but invariants are duplicated and global terminal/state coupling is high |
| **Overall production readiness** | **2/10** | **Backtest-ready only; do not trade live funds** |

---

## Appendix A: Files changed by the audit patch

The following are the files modified by this audit. `trading/scanner.ts` and `trading/service.ts` already had user changes; the patch preserved and completed the relevant portions.

- `backend/src/modules/risk/engine.ts`
- `backend/src/modules/scalping/scalping.service.ts`
- `backend/src/modules/telegram/bot.ts`
- `backend/src/modules/trading/routes.ts`
- `backend/src/modules/trading/scanner.ts`
- `backend/src/modules/trading/service.ts`
- `backend/src/modules/whatsapp/routes.ts`
- `backend/src/tests/risk.test.ts`
- `backend/src/tests/scalping-service.test.ts`
- `backend/src/tests/trading-pipeline.test.ts`
- `docs/TECHNICAL.md`
- `mt5-bridge/Dockerfile`
- `mt5-bridge/Dockerfile.real`
- `docs/production-readiness-audit-2026-07-16.md` (this report)

Pre-existing user changes not introduced by this audit included package locks, AI prompt/schema/service files, sentiment service, untracked analysis context/features, and binary cache/settings files. They were not reverted.

## Appendix B: Verification performed

### Initial baseline

- Backend typecheck: failed at the stale scanner prompt call.
- Backend tests: 46 files / 325 tests passed despite the type error.
- Frontend typecheck: passed.
- Frontend tests: 3 files / 8 tests passed.
- Python filling-mode tests: 2 passed.
- Compose configuration: valid.
- Local bridge health: unavailable; no real/demo MT5 runtime connected.
- Production dependency audit: backend 0 known vulnerabilities; frontend 2 moderate transitive PostCSS advisories through Next, with no currently offered lockfile fix.

### After patch

- `backend: npm run verify`: passed.
- `backend: npm run build`: passed.
- Backend tests: **46 files / 333 tests passed**.
- `frontend: npm run typecheck`: passed.
- Frontend tests: **3 files / 8 tests passed**.
- `frontend: npm run build`: passed (Next.js 15.5.19 production build).
- Python `unittest test_filling_mode.py`: **2 passed**.
- Python `py_compile main.py filling.py`: passed.
- `docker compose config --quiet`: passed.
- `docker build --check mt5-bridge`: passed with no warnings.
- `git diff --check`: passed.

## Appendix C: What remains unverified

- No real MetaTrader 5 terminal/account was available.
- No demo broker order, rejection, partial fill, close, modify, or reconciliation was exercised.
- No native MQL5 compile exists because the repository contains no MQL5 source.
- No full Docker image run or real Wine/MT5 image build was performed; the mock Dockerfile received a successful static build check.
- No database migration was applied to a clean production-like PostgreSQL instance.
- No multi-instance lease/state test, restart test, network partition, broker disconnect, weekend gap, or emergency residual-position test was run.
- The historical backtest report was not reproduced because the bridge was offline.
- No penetration test or external infrastructure review was performed.

## Appendix D: Demo and controlled-live checklist

### Demo test checklist

- [ ] Use a dedicated MT5 **demo** account with no manual or other-EA positions.
- [ ] Keep all real-account credentials unavailable and keep `STRATEGY_VALIDATION_APPROVED=false`.
- [ ] Confirm exact account login/server/margin mode and every broker symbol suffix/alias.
- [ ] Capture symbol digits, tick size/value, volume min/max/step, stops/freeze level, filling modes, and trade mode.
- [ ] Exercise buy/sell, rejection, partial fill, price drift, modify, close, SL/TP, and reconciliation.
- [ ] Compare every app record with MT5 order/deal/position history and net commission/swap/fee.
- [ ] Restart backend, Redis, Postgres connection, bridge, terminal, and VPS with open positions.
- [ ] Simulate lost HTTP response after fill and prove no duplicate order can occur—after Phase 1 implementation.
- [ ] Simulate stale news, AI timeout, Redis outage, high spread, market close, and gap.
- [ ] Prove emergency flatten retries until no scoped positions remain.
- [ ] Verify scanner/scalping/copy/manual/day/paper semantics and canonical symbol locks.
- [ ] Authenticate and tenant-test WebSocket/connector controls before exposing the UI to any network.

### Controlled-live prerequisites

- [ ] Every P0/P1 safeguard in section 11 is complete and independently reviewed.
- [ ] Immutable per-strategy certification is current and bound to code/data/config/broker/cost hashes.
- [ ] True nested walk-forward and untouched lockbox pass predefined criteria.
- [ ] Stressed execution/portfolio/Monte Carlo results meet drawdown and ruin limits.
- [ ] Long-duration demo forward results match broker statements and expected execution tolerance.
- [ ] Dedicated account; no manual/other-EA positions; tiny predefined capital and maximum total loss.
- [ ] External alerts, operator coverage, runbooks, backup/restore, kill switch, and rollback are tested.
- [ ] Start with one symbol/strategy and minimum safe volume; scale only after objective review.
