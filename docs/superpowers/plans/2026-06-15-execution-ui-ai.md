# Execution Intelligence, Frontend, and AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the code-addressable execution diagnostics, authentication hardening, dashboard evidence, provider routing, sentiment, journal, and live P&L requirements from the approved production-hardening design.

**Architecture:** Pure calculation modules own exposure and execution variance math. Durable Prisma models own comparisons and journal entries. Trading/reconciliation services populate those models, while Fastify routes expose user-scoped data. The Next.js app consumes the APIs through existing helpers and the WebSocket hub supplies floating P&L updates. AI routing remains provider-neutral and trade vetting fails closed.

**Tech Stack:** TypeScript, Vitest, Prisma/Postgres, Fastify, Next.js, React, WebSocket, Ollama HTTP API, Anthropic Messages API.

---

### Task 1: Expected Versus Actual Execution

**Files:**
- Create: `backend/src/modules/trading/execution-comparison.ts`
- Create: `backend/src/tests/execution-comparison.test.ts`
- Modify: `backend/prisma/schema.prisma`
- Extend: `backend/prisma/migrations/20260615_research_validation/migration.sql`
- Modify: `backend/src/modules/trading/service.ts`
- Modify: `backend/src/modules/trading/reconciliation.ts`
- Modify: `backend/src/modules/trading/routes.ts`

- [ ] Write failing tests proving entry slippage, latency, exit variance, and P&L variance use consistent signs and percentages.
- [ ] Run `npm test -- --run src/tests/execution-comparison.test.ts` and verify RED.
- [ ] Implement pure comparison calculations and add `ExecutionComparison` with expected/actual entry, exit, spread, slippage, latency, P&L, and variance fields.
- [ ] Capture expected execution when a broker order is proposed, update actual entry after fill, and finalize exit/P&L during reconciliation only for attributable trades.
- [ ] Expose `GET /api/execution-comparisons` scoped to `req.user.id`.
- [ ] Generate Prisma, rerun the focused test, and verify GREEN.

### Task 2: Exposure and Correlation Risk Gate

**Files:**
- Create: `backend/src/modules/risk/exposure.ts`
- Create: `backend/src/tests/exposure.test.ts`
- Modify: `backend/src/modules/risk/engine.ts`
- Modify: `backend/src/modules/trading/service.ts`
- Modify: `backend/src/modules/trading/routes.ts`

- [ ] Write failing tests for FX base/quote currency exposure, metals/indices USD exposure, same-direction correlated-symbol concentration, and proposed-trade limits.
- [ ] Run `npm test -- --run src/tests/exposure.test.ts` and verify RED.
- [ ] Implement `calculateExposure(positions, ticks)` and `evaluateExposureGate(proposal, exposure, limits)` as pure functions.
- [ ] Add conservative configurable defaults to risk settings and block proposals that exceed currency or correlated-symbol caps.
- [ ] Expose `GET /api/exposure` with current currency, symbol, and correlation-group totals.
- [ ] Re-run exposure and trading-pipeline tests and verify GREEN.

### Task 3: News Flattening and Attribution Confidence

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Extend: `backend/prisma/migrations/20260615_research_validation/migration.sql`
- Create: `backend/src/modules/news/flatten.ts`
- Create: `backend/src/tests/news-flatten.test.ts`
- Modify: `backend/src/modules/trading/reconciliation.ts`
- Modify: `backend/src/tests/trading-reconciliation.test.ts`
- Modify: `backend/src/workers/scheduler.ts`

- [ ] Write failing tests proving flattening defaults off, only high-impact matching events inside the lead window qualify, and symbol scope is respected.
- [ ] Implement risk-setting fields for enablement, lead minutes, minimum impact, and symbol scope; scheduler closes only qualifying positions.
- [ ] Write a failing reconciliation test for ambiguous netting attribution.
- [ ] Add attribution confidence and reason to trade reconciliation; ambiguous mappings create an incident, leave per-trade P&L unset, and remain excluded from loss-streak calculations.
- [ ] Re-run focused tests and verify GREEN.

### Task 4: Authentication and Browser Hardening

**Files:**
- Create: `frontend/lib/auth.ts`
- Create: `frontend/lib/auth.test.ts`
- Modify: `frontend/lib/api.ts`
- Modify: `frontend/app/layout.tsx`
- Create: `frontend/app/error.tsx`
- Create: `frontend/app/dashboard/error.tsx`
- Create: `frontend/app/dashboard/loading.tsx`
- Modify: `frontend/next.config.*`
- Modify: `.env.example`

- [ ] Write failing tests for JWT payload decoding, expiry detection, and automatic local-storage logout.
- [ ] Implement short-expiry handling without adding refresh tokens or cookies.
- [ ] Add CSP, frame, MIME, referrer, and permissions headers while retaining the existing API/WebSocket origins.
- [ ] Add route-level error boundaries and loading states; standardize dashboard empty/error rendering.
- [ ] Run frontend typecheck/tests/build and verify GREEN.

### Task 5: Provider-Neutral AI and Structured Sentiment

**Files:**
- Modify: `backend/src/config.ts`
- Refactor: `backend/src/modules/ai/service.ts`
- Create: `backend/src/modules/ai/providers/ollama.ts`
- Create: `backend/src/modules/ai/providers/anthropic.ts`
- Create: `backend/src/tests/ai-routing.test.ts`
- Create: `backend/src/modules/sentiment/service.ts`
- Create: `backend/src/tests/sentiment.test.ts`
- Modify: `backend/src/index.ts`
- Modify: `.env.example`

- [ ] Write failing provider-routing tests for configured Claude use, permitted Ollama fallback, and fail-closed trade vetting when both fail or return invalid JSON.
- [ ] Implement a provider interface and Anthropic Messages adapter using `fetch`; keep Ollama as default.
- [ ] Write failing sentiment tests for normalized score, label, source provenance, and age.
- [ ] Implement cached per-symbol sentiment from configured web-search results and expose `GET /api/sentiment/:symbol`.
- [ ] Re-run AI, dependency-resilience, and sentiment tests and verify GREEN.

### Task 6: Journal and Real-Time Floating P&L

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Extend: `backend/prisma/migrations/20260615_research_validation/migration.sql`
- Create: `backend/src/modules/journal/routes.ts`
- Create: `backend/src/tests/journal.test.ts`
- Modify: `backend/src/modules/ws/hub.ts`
- Modify: `backend/src/workers/scheduler.ts`
- Modify: `frontend/app/dashboard/page.tsx`
- Create: `frontend/components/IncidentCenter.tsx`
- Create: `frontend/components/ValidationEvidencePanel.tsx`
- Create: `frontend/components/PaperForwardPanel.tsx`
- Create: `frontend/components/ExposurePanel.tsx`
- Create: `frontend/components/ExecutionComparisonPanel.tsx`
- Create: `frontend/components/TradeJournalPanel.tsx`

- [ ] Write failing journal service/route tests for owner scoping, notes, tags, lessons, and ratings.
- [ ] Add `TradeJournalEntry` and CRUD routes.
- [ ] Broadcast `floating_pnl` with positions and aggregate P&L on each scheduler cycle.
- [ ] Add dashboard panels for incidents, validation evidence, paper performance, exposure, execution comparisons, and journal; consume live floating P&L from the existing socket.
- [ ] Run backend and frontend focused verification and inspect the dashboard in the in-app browser.

### Task 7: Final Operational and Deployment Verification

**Files:**
- Modify: `docs/API.md`
- Create: `docs/mt5-demo-validation-checklist.md`

- [ ] Refactor the scheduler lease so position management, paper reconciliation, floating P&L, and broker reconciliation continue when Redis is unavailable; lease only new-trade/scanner work.
- [ ] Add a regression test proving protective work runs while new-trade work remains fail-closed.
- [ ] Run `npx prisma generate` and `npx prisma migrate deploy` against the local demo database.
- [ ] Run `npm audit --json`, apply non-breaking remediations, and document any remaining advisory.
- [ ] Run backend and frontend `npm run verify`, `git diff --check`, `docker compose config`, and full Docker builds.
- [ ] Start Compose, verify health endpoints and dashboard rendering, then stop it cleanly.
- [ ] Document hedging/netting demo checks and mark genuine broker/netting evidence and profitability evidence as pending external gates.
