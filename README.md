# MT5 AI Trading Bot Platform

AI-powered trading automation for MetaTrader 5 with a local LLM brain (Gemma via Ollama),
strict risk management, news intelligence, copy trading, and Telegram / WhatsApp / web control.

> ⚠️ **Safety first.** Demo mode is the default. Live trading is locked behind dashboard
> Settings, admin opt-in, 2FA, and risk-engine checks; every trade — manual, AI, automatic, or
> copied — must pass the risk engine. Test on a demo account before considering live use.
> Trading involves substantial risk of loss; nothing here is financial advice.

## Architecture

```
┌────────────┐   ┌──────────────┐   ┌──────────────┐
│  Next.js    │   │ Telegram bot │   │ WhatsApp     │
│  dashboard  │   │ (grammY)     │   │ (Twilio)     │
└──────┬─────┘   └──────┬───────┘   └──────┬───────┘
       │ REST+WS        │                  │ webhook
       ▼                ▼                  ▼
┌─────────────────────────────────────────────────────┐
│             Backend API (Fastify + TS)              │
│  auth/2FA · strategy engine · risk engine · news    │
│  trade pipeline · copy trading · notifications      │
│  audit log · WebSocket hub · background worker      │
└────┬──────────────┬──────────────┬─────────────────┘
     │              │              │
     ▼              ▼              ▼
┌──────────┐  ┌───────────┐  ┌────────────────┐
│ Postgres │  │  Ollama    │  │  MT5 Bridge    │
│ (Prisma) │  │  (Gemma)   │  │  (FastAPI, py) │
└──────────┘  └───────────┘  │  mock OR real  │
                             └───────┬────────┘
                                     ▼
                              MetaTrader 5
```

**Trade pipeline** (the only path to a position):
market data → analysis engine → news gate → strategy signal → **AI reasoning (advisory — can
veto, never force)** → **risk engine (final authority)** → mode gate (manual / approval / auto)
→ execution → audit + notify. Every step is stored in the trade's `explanation` JSON.

## Quick start (demo mode, no MT5 terminal needed)

Prereqs: Node 22+, Python 3.12+, Docker (for Postgres/Redis), optionally Ollama.

```bash
cp .env.example .env
# Edit .env: set JWT_SECRET and CREDENTIALS_ENC_KEY (openssl rand -hex 32)

# 1. Infrastructure
docker compose up -d postgres redis

# 2. MT5 bridge (mock broker — runs anywhere)
cd mt5-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
MT5_MOCK=true BRIDGE_API_KEY=change-me-bridge-key python main.py &

# 3. Backend
cd ../backend
npm install
npx prisma migrate dev --name init
npm run seed            # admin@example.com / changeme123 — change it!
npm run dev

# 4. Frontend
cd ../frontend
npm install
npm run dev             # http://localhost:3000

# 5. (optional) AI brain
ollama pull gemma3:12b  # set OLLAMA_MODEL in .env to the model you pulled
ollama serve
```

Or run everything with Docker: `docker compose --profile ai up --build`.

Without Ollama running, the platform still works: AI responses fall back to a hard-coded
`avoid` decision, so no AI-assisted trades will be taken (manual risk-gated trades still work).

## Testing it end-to-end (demo)

1. Log in at `http://localhost:3000` (seeded admin or register — first user becomes admin).
2. **Settings tab** → review risk settings, save.
3. **Strategies tab** → add the "Trend Follower (H1)" preset → Enable.
4. **Overview tab** → set mode to *Semi-automatic* → **Start**.
5. The worker evaluates enabled strategies every 60s against the mock broker. When a signal
   passes strategy + AI + risk gates you'll get an approval request (dashboard badge,
   Telegram/WhatsApp if linked). Approve it and watch the position appear.
6. Click any trade in *Trade history* to see the full decision trail (strategy reasons, AI
   reasoning, every risk check, news assessment).
7. Try **EMERGENCY STOP** — bot halts and all mock positions close.
8. Run the unit tests: `cd backend && npm test` (risk engine + indicators + AI validation).

## Going live (deliberately hard)

1. Run the bridge on a Windows machine/VPS with the MT5 terminal:
   `pip install MetaTrader5`, set `MT5_MOCK=false`, `MT5_LOGIN/MT5_PASSWORD/MT5_SERVER` env vars.
2. In the dashboard Settings screen: enable 2FA, then enable live trading (admin + TOTP).
3. Confirm the bot state shows LIVE before starting automatic execution.
4. Every live approval and manual trade now requires a fresh TOTP code.

The Settings live switch, user live opt-in, 2FA, account verification, strategy validation, and
risk limits are re-checked inside the risk engine on **every** trade.

## Connectors

- **Telegram**: set `TELEGRAM_BOT_TOKEN` (via @BotFather). In the dashboard, Settings →
  *Link Telegram* → send `/link <code>` to your bot. Commands: `/status /open_trades /profit
  /news /pause_bot /resume_bot /emergency_stop /approve_trade /reject_trade /copy_trader /settings`.
  Dangerous commands require `/confirm`; live approvals require a TOTP code.
- **WhatsApp**: configure Twilio sandbox/sender, point the inbound webhook to
  `POST /webhooks/whatsapp`. Link with `link <code>`. Plain-text commands: `status`,
  `open trades`, `today's profit`, `latest news`, `pause bot`, `resume bot`, `emergency stop`
  (reply `CONFIRM`), `approve trade <id> [2fa]`, `reject trade <id>`, `copy trading status`.

## Project layout

```
backend/            Fastify + TypeScript API, risk/strategy/AI/news/copy engines, workers
backend/prisma/     Schema (users, trades, approvals, strategies, risk, copy, news, audit…)
backend/src/tests/  Vitest unit tests for risk engine, indicators, AI validation
mt5-bridge/         Python FastAPI bridge: mock broker + real MetaTrader5 adapter
frontend/           Next.js dashboard (overview, trades, strategies, copy, news, settings)
docs/API.md         Full REST/WS API reference
```

## Security model

- JWT auth, bcrypt password hashing, role-based access (ADMIN / MANAGER / VIEWER).
- TOTP 2FA gating all live-trading actions.
- Broker credentials AES-256-GCM encrypted at rest; secrets only via env vars; logs redact
  password/token/secret fields.
- Telegram/WhatsApp users must be explicitly linked + verified; every command is audit-logged;
  unauthorized commands are rejected and logged. Twilio webhook signatures validated in production.
- Connectors and frontend can NEVER reach MT5 directly — only the backend talks to the bridge,
  and the bridge requires an API key.
- Rate limiting, zod input validation on every route, generic error responses (no internals leaked).
- Append-only audit log of logins, commands, settings changes, AI outputs, risk verdicts,
  approvals, executions, and emergency stops.

## Critical safety rules (enforced in code)

1. Demo mode default; live trading is gated by Settings, admin opt-in, 2FA, account verification, and strategy validation — `risk/engine.ts`.
2. No trade without risk validation — single execution path through `validateTrade()`.
3. Stop-loss required (admin-only to disable) — risk engine + settings route.
4. The AI never executes trades — it returns JSON that is schema-validated; invalid/missing
   output becomes `avoid`. It can veto a signal but cannot create or force one.
5. Copy trades go through the same risk engine, plus copy-specific exposure caps.
6. High-impact news pauses or reduces trading per user settings.
7. Emergency stop overrides everything, closes all positions, and requires an admin reset.
8. Every trade carries a full, human-readable decision trail.
```
