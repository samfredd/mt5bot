# Backend API Reference

Base URL: `http://localhost:4000`. All `/api/*` routes require `Authorization: Bearer <JWT>`.
Rate limit: 200 requests/minute per IP.

## Auth

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/auth/register` | — | `{email, password}`. First user becomes ADMIN. |
| POST | `/auth/login` | — | Returns `{token, user}`. |
| POST | `/auth/2fa/setup` | any | Returns TOTP `secret` + `otpauthUrl`. |
| POST | `/auth/2fa/enable` | any | `{token}` — verifies and enables 2FA. |
| POST | `/auth/live/enable` | ADMIN | `{token}` (TOTP). Enables live trading in persisted bot Settings and sets the user live flag. |
| POST | `/auth/live/disable` | any | Disables live trading in bot Settings and clears the user live flag. |
| POST | `/auth/link/telegram` | any | Returns a one-time code; send `/link <code>` to the Telegram bot. |
| POST | `/auth/link/whatsapp` | any | Returns a one-time code; send `link <code>` via WhatsApp. |

## Bot control

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/health` | — | Backend + MT5 bridge + Ollama health. |
| GET | `/api/bot/state` | any | `{status, mode, emergencyStop, demoMode, liveTradingEnabled}` |
| POST | `/api/bot/start` | ADMIN/MANAGER | Refuses if emergency stop active or risk settings missing. |
| POST | `/api/bot/pause` | ADMIN/MANAGER | Pause new trades. |
| POST | `/api/bot/mode` | ADMIN/MANAGER | `{mode: MANUAL\|SEMI_AUTO\|AUTO\|COPY}` |
| POST | `/api/bot/emergency-stop` | **any authenticated** | Halts bot AND closes all positions. |
| POST | `/api/bot/emergency-reset` | ADMIN | Clears emergency stop (bot left paused). |

## Trading

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/overview` | any | Dashboard snapshot (account, positions, P/L, state). |
| GET | `/api/trades?status=&limit=` | any | Trade list with decision trails. |
| GET | `/api/trades/:id` | any | Single trade incl. AI analysis log. |
| POST | `/api/trades/:id/approve` | ADMIN/MANAGER | `{totp?}` — TOTP required outside demo mode. Re-runs full risk check before executing. |
| POST | `/api/trades/:id/reject` | ADMIN/MANAGER | Reject a pending trade. |
| POST | `/api/trades/manual` | ADMIN/MANAGER | `{symbol, direction, lots, stopLoss, takeProfit, totp?}` — still risk-gated. |
| POST | `/api/positions/:ticket/close` | ADMIN/MANAGER | Close an open position. |
| POST | `/api/positions/:ticket/modify` | ADMIN/MANAGER | `{sl?, tp?}` |
| GET | `/api/market/:symbol?timeframe=H1` | any | Tick + candles. |

## Strategies & risk

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/strategies` | any | List user strategies. |
| GET | `/api/strategies/presets` | any | Built-in presets. |
| POST | `/api/strategies` | ADMIN/MANAGER | `{name, type, config}` — config validated by schema. |
| PUT | `/api/strategies/:id` | ADMIN/MANAGER | `{name?, enabled?, config?}` |
| DELETE | `/api/strategies/:id` | ADMIN | Delete. |
| GET | `/api/risk-settings` | any | Current risk settings (auto-created). |
| PUT | `/api/risk-settings` | ADMIN/MANAGER | Update. `requireStopLoss:false` requires ADMIN. |

## Copy trading

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/copy-traders` | any | List traders w/ copied count. |
| POST | `/api/copy-traders` | ADMIN/MANAGER | `{name, source, metrics, copyRules}` — auto-scored. |
| POST | `/api/copy-traders/:id/evaluate` | any | Deterministic score + AI explanation. |
| POST | `/api/copy-traders/:id/activate` | ADMIN/MANAGER | Refused if riskScore ≥ 70. |
| POST | `/api/copy-traders/:id/deactivate` | ADMIN/MANAGER | Stop copying. |
| PUT | `/api/copy-traders/:id/rules` | ADMIN/MANAGER | Update copy rules. |
| POST | `/api/copy-traders/:id/signal` | ADMIN/MANAGER | Ingest a source trade `{symbol, direction, lots, sl?, tp?, ref?}` — runs copy rules + risk engine. |
| GET | `/api/copied-trades` | any | Copied trade history. |

## News, notifications, audit

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/news` | any | Calendar events (next 24h). |
| POST | `/api/news/refresh` | ADMIN/MANAGER | Re-fetch calendar feed. |
| GET | `/api/news/risk/:symbol` | any | `{level, action, reason, upcomingEvents}` |
| GET | `/api/notifications` | any | Last 50 notifications. |
| PUT | `/api/notifications/prefs` | any | `{telegram?: bool, whatsapp?: bool, email?: bool}` |
| GET | `/api/audit?category=&limit=` | ADMIN/MANAGER | Audit trail. |

## WebSocket

`ws://localhost:4000/ws` — JSON frames `{event, data, ts}`. Events:
`notification`, `trade`, `approval_request`, `bot_state`, `emergency_stop`.

## Webhooks

`POST /webhooks/whatsapp` — Twilio inbound webhook (form-encoded, signature-validated in production).

## MT5 bridge (internal, port 5001)

All requests need `X-API-Key`. The backend is the only intended client.
`GET /health /account /positions /history /tick/:symbol /candles/:symbol /symbols`,
`POST /order /position/:ticket/modify /position/:ticket/close`.
