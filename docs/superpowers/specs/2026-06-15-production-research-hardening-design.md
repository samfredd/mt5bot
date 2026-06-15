# Production and Research Hardening Design

## Objective

Complete the remaining safety, research, deployment, execution-intelligence,
frontend, and AI work for a single-instance Docker deployment on this machine.
The system must remain unable to trade live until strategy validation and broker
reconciliation are explicitly approved.

## Deployment Boundary

The application runs as one Docker Compose deployment:

- `frontend`: Next.js dashboard.
- `backend`: API, scheduler, trading, research, and WebSocket services.
- `postgres`: durable application, trading, research, and incident data.
- `redis`: shared bot state, scheduler leases, revocations, caches, rate limits,
  and circuit-breaker state.
- `mt5-bridge`: MetaTrader broker connection.
- `ollama`: default local AI provider.
- Anthropic Claude API: optional research and reasoning provider, enabled only
  when configured with a valid API key.

The design targets one backend instance now. Redis is still used for operational
state so a future multi-instance deployment does not require redesigning the
state contracts.

## Delivery Phases

### 1. Operational Safety

- Move bot state, scheduler leases, revocation state, and relevant caches to
  Redis with Postgres or safe local fallback where specified.
- Add bounded exponential retry with jitter to idempotent MT5, AI, news, and
  web-search reads.
- Add persisted circuit breakers for MT5, AI, news, and web search.
- Do not retry order placement after an uncertain outcome. A retry is permitted
  only after a definitive rejection proves that no order was created.
- Add durable, deduplicated in-app incidents and WebSocket incident updates.
- Correct Docker service networking, startup ordering, health checks, and
  production secret validation.
- Keep `DEMO_MODE=true`, `LIVE_TRADING_ENABLED=false`, and `REQUIRE_2FA=true`.

### 2. Research Validation

- Add bootstrap or Monte Carlo resampling of backtest trades with return and
  drawdown confidence intervals.
- Add an explicit held-out out-of-sample period that is never used by candidate
  generation or parameter selection.
- Add multi-instrument portfolio validation with aggregate exposure, return,
  drawdown, and consistency metrics.
- Retain the existing parameter-sensitivity sweep as a mandatory gate.
- Add paper-forward mode that runs the production signal and risk pipeline but
  records simulated orders and fills instead of calling the broker.
- Save complete validation evidence and pass/fail reasons. Passing validation
  permits administrative review; it does not automatically prove an edge or
  enable live trading.

### 3. Execution Intelligence

- Capture expected spread, slippage, entry, exit, and P&L assumptions for paper
  and broker trades.
- Compare expected execution with actual fills, latency, slippage, exit, and
  realized P&L.
- Calculate net currency and correlated-symbol exposure before order approval
  and expose it in the dashboard.
- Add configurable high-impact-news flattening. It defaults off and requires
  explicit event severity, lead time, and symbol scope.
- Record broker attribution confidence during reconciliation.
- On netting accounts, assign per-trade profit only when one bot trade maps
  unambiguously to one broker position. Ambiguous results create incidents and
  are excluded from per-trade loss-streak calculations.

### 4. Frontend and Authentication Hardening

- Retain JWTs in `localStorage` as requested.
- Shorten JWT lifetime, decode expiration in the client, automatically log out
  expired sessions, and preserve server-side role enforcement as authoritative.
- Add a restrictive Content Security Policy and standard browser security
  headers.
- Do not introduce raw HTML rendering or unsafe script evaluation.
- Add route-level error boundaries and standardized loading, empty, and error
  states for dashboard modules.

### 5. AI and User Features

- Add provider-neutral AI routing with optional Anthropic Claude support and
  Ollama as the local provider.
- Claude-to-Ollama fallback is allowed for research and non-order-critical
  reasoning when policy permits it.
- Trade vetting fails closed when the selected model is unavailable, invalid,
  or returns an unparseable decision.
- Add structured per-symbol sentiment derived from configured web-search
  sources and include its provenance and age.
- Add trade journal notes, tags, lessons, and manual ratings.
- Broadcast floating P&L over the existing WebSocket and render it without the
  current polling delay.

## Durable Data Model

### Incident

Stores severity, source, deduplication key, message, structured context, status,
occurrence count, first occurrence, latest occurrence, acknowledgement, and
resolution metadata.

### PaperTrade

Stores strategy, symbol, direction, proposal, market snapshot, risk decision,
simulated entry and exit, lifecycle status, expected costs, and outcome.

### ValidationRun

Stores candidate and strategy identity, training and OOS ranges, instruments,
parameter variants, Monte Carlo intervals, portfolio metrics, gate results, and
complete rejection reasons.

### ExecutionComparison

Stores expected and actual entry, exit, spread, slippage, latency, P&L, and the
absolute and percentage variance for each attributable trade.

### TradeJournalEntry

Stores author, trade reference, notes, tags, lessons, rating, and timestamps.

No refresh-session table is added because cookie-based refresh sessions were
explicitly declined.

## Redis Contracts

- `bot:state`: current operational state mirrored from durable settings.
- `lock:scheduler:<job>`: renewable job lease with owner token and bounded TTL.
- `circuit:<dependency>`: closed, open, or half-open state plus counters and
  cooldown timestamps.
- `cache:symbol:*` and `cache:news:*`: short-lived dependency caches.
- `jwt:revoked:<jti>`: revocation marker expiring with the token.

If Redis is unavailable, new-trade evaluation fails closed. Position protection
continues through direct MT5 calls where it can operate safely. An in-app
incident records the degraded state.

## Failure Handling

- Retry only operations classified as idempotent.
- Use bounded exponential delays with jitter and per-dependency limits.
- Open a circuit after repeated qualifying failures, reject calls during the
  cooldown, and permit a bounded half-open recovery probe.
- Aggregate repeated incidents by deduplication key instead of creating an
  unbounded stream of duplicate records.
- Create critical incidents for bridge disconnection, guardian activation,
  ambiguous reconciliation, open dependency circuits, stale paper-forward
  processing, validation-system failure, and unsafe configuration.
- All operational alerts remain in-app only.

## Frontend Surfaces

- Incident center with severity, occurrence count, acknowledgement, and
  resolution controls.
- Validation details with OOS periods, sensitivity verdicts, Monte Carlo ranges,
  portfolio metrics, and rejection reasons.
- Paper-forward performance with administrative promotion review.
- Currency and correlated-symbol exposure dashboard.
- Expected-versus-actual execution comparison.
- Trade journal editor.
- Real-time floating P&L stream.

## Verification

- Unit tests cover retry policy, circuit state transitions, exposure math,
  Monte Carlo determinism, OOS isolation, JWT expiry, and each validation gate.
- Integration tests cover paper-forward execution, incident aggregation, Redis
  failure behavior, scheduler leases, Claude/Ollama routing, and ambiguous
  reconciliation.
- Existing trade-pipeline and reconciliation tests remain mandatory.
- Backend verification runs typecheck and the complete Vitest suite.
- Frontend verification runs typecheck and a production Next.js build.
- Docker verification validates Compose configuration and container health.
- A scripted MT5 demo checklist records hedging and netting-account evidence.
  This external evidence cannot be replaced by mocks.

## Explicit Non-Goals

- No live-funds testing or live-trading enablement.
- No claim that a strategy is profitable without forward evidence.
- No HttpOnly-cookie or refresh-token migration.
- No email, Telegram, WhatsApp, PagerDuty, or Sentry alerts.
- No automatic retry of uncertain broker order placement.
- No multi-host or multi-region deployment in this phase.

## Completion Criteria

The code-addressable work is complete when all phases are implemented, Docker
starts with healthy dependencies, full verification passes, and the dashboard
exposes the new operational and research evidence. Real MT5 netting validation
and proof of trading edge remain explicit external gates; they must be recorded
as pending until genuine demo and forward-market evidence exists.
