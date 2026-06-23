# Operational Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Redis-backed operational state, scheduler leases, dependency resilience, durable in-app incidents, truthful health reporting, and production-safe Docker startup while live trading remains disabled.

**Architecture:** A small Redis adapter owns connectivity and typed JSON helpers. A dependency-agnostic resilience module implements retry and circuit-breaker state, while the incident service persists deduplicated failures in Postgres and broadcasts changes. Existing MT5, AI, news, web-search, state, scheduler, and health modules consume these APIs without changing order-placement semantics.

**Tech Stack:** TypeScript, Vitest, Prisma/Postgres, ioredis, Fastify, Docker Compose.

---

### Task 1: Redis Adapter and Leases

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Create: `backend/src/lib/redis.ts`
- Create: `backend/src/tests/redis.test.ts`

- [ ] **Step 1: Write failing Redis helper tests**

Test an injected Redis-like client through exported helpers:

```ts
expect(await readJson("missing")).toBeNull();
expect(await writeJson("state", { status: "running" }, 60)).toBe(true);
expect(await acquireLease("scheduler:analysis", "owner-a", 30_000)).toBe(true);
expect(await acquireLease("scheduler:analysis", "owner-b", 30_000)).toBe(false);
expect(await releaseLease("scheduler:analysis", "owner-b")).toBe(false);
expect(await releaseLease("scheduler:analysis", "owner-a")).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run src/tests/redis.test.ts`

Expected: FAIL because `lib/redis.ts` does not exist.

- [ ] **Step 3: Install and implement Redis support**

Add `ioredis`. Export `redisAvailable()`, `readJson<T>()`, `writeJson()`, `deleteKey()`, `acquireLease()`, `renewLease()`, `releaseLease()`, and `disconnectRedis()`. Use compare-and-delete and compare-and-expire Lua scripts so one owner cannot release another owner's lease. Every helper catches connection errors and returns a safe failure value.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run src/tests/redis.test.ts`

Expected: PASS.

### Task 2: Retry and Circuit Breakers

**Files:**
- Create: `backend/src/lib/resilience.ts`
- Create: `backend/src/tests/resilience.test.ts`

- [ ] **Step 1: Write failing deterministic tests**

Cover bounded retry, no retry when disabled, circuit opening, cooldown rejection, and one half-open recovery probe. Inject `sleep`, `now`, and state storage so tests do not wait on wall-clock time.

```ts
const result = await withResilience("news", operation, {
  retries: 2,
  baseDelayMs: 10,
  sleep: async (ms) => delays.push(ms),
  now: () => clock,
});
expect(result).toBe("ok");
expect(attempts).toBe(3);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run src/tests/resilience.test.ts`

Expected: FAIL because the resilience module does not exist.

- [ ] **Step 3: Implement the minimal resilience API**

Export `withResilience<T>(dependency, operation, options)`, `CircuitOpenError`, and `circuitSnapshot()`. Persist circuit state through the Redis JSON helpers with an in-memory fallback for health visibility. Use exponential delays capped by `maxDelayMs`; jitter is disabled by an injectable random function in tests. Never use this wrapper around uncertain order placement.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run src/tests/resilience.test.ts`

Expected: PASS.

### Task 3: Durable Incident Aggregation

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260615_operational_incidents/migration.sql`
- Create: `backend/src/modules/incidents/service.ts`
- Create: `backend/src/modules/incidents/routes.ts`
- Create: `backend/src/tests/incidents.test.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write failing service tests**

Test that repeated active incidents with the same deduplication key increment `occurrenceCount`, update `lastSeenAt`, and broadcast once per occurrence; acknowledgement and resolution update status and actor metadata.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run src/tests/incidents.test.ts`

Expected: FAIL because the incident service does not exist.

- [ ] **Step 3: Add the schema and service**

Add `IncidentSeverity` (`INFO`, `WARNING`, `CRITICAL`) and `IncidentStatus` (`OPEN`, `ACKNOWLEDGED`, `RESOLVED`) enums plus an `Incident` model with `dedupeKey`, `source`, `title`, `message`, `context`, counters, timestamps, and acknowledgement/resolution fields. Implement `reportIncident`, `listIncidents`, `acknowledgeIncident`, and `resolveIncident`.

- [ ] **Step 4: Add authenticated routes**

Register:

```text
GET  /api/incidents?status=OPEN&limit=100
POST /api/incidents/:id/acknowledge
POST /api/incidents/:id/resolve
```

Require authentication for listing and manager/admin role for mutation.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- --run src/tests/incidents.test.ts`

Expected: PASS.

### Task 4: Redis-backed State, Revocation, and Scheduler Locks

**Files:**
- Modify: `backend/src/modules/system/state.ts`
- Modify: `backend/src/modules/auth/service.ts`
- Modify: `backend/src/workers/scheduler.ts`
- Create: `backend/src/tests/operational-state.test.ts`

- [ ] **Step 1: Write failing behavior tests**

Cover state cache reads/writes through `bot:state`, revocation reads/writes through `jwt:revoked:<userId>`, and `withSchedulerLease()` skipping a job when a lease is held. Verify Redis failure causes `operationalTradingAvailable()` to return false while durable bot state remains readable from Postgres.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run src/tests/operational-state.test.ts`

Expected: FAIL because the operational APIs are absent.

- [ ] **Step 3: Implement state and revocation mirrors**

Read Redis first and fall back to Postgres. Persist state and revocation changes to Postgres first, then mirror them to Redis. Export `operationalTradingAvailable()`; it returns false when Redis is configured but unavailable, allowing trading gates to fail closed without preventing position-management calls.

- [ ] **Step 4: Add scheduler leases**

Export and use `withSchedulerLease(job, ttlMs, fn)` around analysis, news refresh, and lab jobs. Use unique owner tokens, lease renewal for long jobs, and guaranteed owner-checked release.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- --run src/tests/operational-state.test.ts`

Expected: PASS.

### Task 5: Dependency Integration and Incident Reporting

**Files:**
- Modify: `backend/src/modules/mt5/client.ts`
- Modify: `backend/src/modules/ai/service.ts`
- Modify: `backend/src/modules/news/service.ts`
- Modify: `backend/src/modules/news/headlines.ts`
- Modify: `backend/src/modules/web/search.ts`
- Modify: `backend/src/modules/trading/service.ts`
- Modify: `backend/src/modules/trading/reconciliation.ts`
- Modify: `backend/src/workers/scheduler.ts`
- Create: `backend/src/tests/dependency-resilience.test.ts`

- [ ] **Step 1: Write failing integration tests**

Verify idempotent MT5 reads retry, order placement calls the bridge once, an open MT5 circuit blocks new trade evaluation, and repeated ambiguous reconciliation creates one aggregated critical incident.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run src/tests/dependency-resilience.test.ts`

Expected: FAIL because dependency calls do not use resilience or incidents.

- [ ] **Step 3: Wrap safe dependency calls**

Use `withResilience` for health, account, positions, history, tick, candles, symbol, news, headline, web-search, and model reads. Set `retries: 0` for `placeOrder`, `closePosition`, `modifyPosition`, and account switching unless the endpoint returns a definitive normal response.

- [ ] **Step 4: Report operational incidents**

Report bridge circuit opening, AI circuit opening, guardian activation, scheduler job failure, Redis degradation, and unattributed reconciliation. Preserve existing error logs and notifications.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- --run src/tests/dependency-resilience.test.ts src/tests/trading-pipeline.test.ts src/tests/trading-reconciliation.test.ts`

Expected: PASS.

### Task 6: Production Configuration, Health, and Docker

**Files:**
- Modify: `backend/src/config.ts`
- Modify: `backend/src/modules/system/routes.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/Dockerfile`
- Modify: `frontend/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Create: `backend/src/tests/production-config.test.ts`

- [ ] **Step 1: Write failing production-config tests**

Verify production rejects default JWT, encryption, bridge, or database credentials, while development accepts explicit local values. Verify health reports Redis status and circuit snapshots.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run src/tests/production-config.test.ts`

Expected: FAIL because production secret refinement and health fields are absent.

- [ ] **Step 3: Add startup validation and graceful shutdown**

Use a Zod `superRefine` for production-only unsafe defaults. Connect/check Redis before starting workers, create an incident when unavailable, close Redis during shutdown, and keep workers from starting new-trade analysis until operational dependencies are ready.

- [ ] **Step 4: Correct Docker networking and health checks**

Run Ollama as an optional Compose profile reachable at `http://ollama:11434`; add health checks for Postgres, Redis, bridge, backend, and frontend; make backend depend on healthy dependencies; add restart policies; keep the real bridge outside this mock Compose profile; and remove secret defaults from production service configuration.

- [ ] **Step 5: Verify GREEN and Compose**

Run: `npm test -- --run src/tests/production-config.test.ts`

Run: `docker compose config`

Expected: test PASS and Compose configuration renders without errors.

### Task 7: Phase Verification

**Files:**
- Review all Phase 1 files.

- [ ] **Step 1: Generate Prisma client**

Run: `npx prisma generate`

Expected: Prisma client generated successfully.

- [ ] **Step 2: Run backend verification**

Run: `npm run verify`

Expected: typecheck and all tests pass.

- [ ] **Step 3: Run frontend verification**

Run: `npm run verify`

Expected: typecheck and production build pass.

- [ ] **Step 4: Check the final diff**

Run: `git diff --check`

Expected: no whitespace errors.
