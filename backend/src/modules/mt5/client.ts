import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { audit, logError } from "../../lib/audit.js";
import { CircuitOpenError, circuitSnapshot, withResilience } from "../../lib/resilience.js";
import type { TradingInstrumentSpec } from "../risk/instruments.js";
import { reportIncident, resolveIncidentByDedupeKey } from "../incidents/service.js";

/**
 * HTTP client for the Python MT5 bridge. This is the ONLY place in the
 * backend that talks to MT5. Every request and response is logged.
 */

export interface AccountInfo {
  login: string;
  balance: number;
  equity: number;
  margin: number;
  free_margin: number;
  margin_level: number;
  currency: string;
  is_demo: boolean;
  // Broker server name; absent until the bridge is restarted on a build that sends it.
  server?: string;
}

export interface Position {
  ticket: string;
  symbol: string;
  type: "buy" | "sell";
  volume: number;
  price_open: number;
  price_current?: number;
  sl: number | null;
  tp: number | null;
  profit: number;
  time: string;
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  spread_points: number;
  time: string;
}

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
}

export interface BrokerSymbolInfo {
  symbol: string;
  digits: number;
  point: number;
  trade_tick_size: number;
  trade_tick_value: number;
  volume_min: number;
  volume_max: number;
  volume_step: number;
  trade_stops_level: number;
}

export function mapBrokerSymbolInfo(info: BrokerSymbolInfo): TradingInstrumentSpec {
  return {
    symbol: info.symbol,
    digits: info.digits,
    point: info.point,
    tickSize: info.trade_tick_size,
    tickValue: info.trade_tick_value,
    volumeMin: info.volume_min,
    volumeMax: info.volume_max,
    volumeStep: info.volume_step,
    stopsLevelPoints: info.trade_stops_level,
  };
}

export interface OrderRequest {
  symbol: string;
  direction: "buy" | "sell";
  volume: number;
  sl?: number;
  tp?: number;
  comment?: string;
}

export interface OrderResult {
  ok: boolean;
  ticket?: string;
  // The position identifier — what positions/history/close/modify all key on.
  // Equals `ticket` on hedging accounts; the aggregate position on netting.
  position_id?: string;
  price?: number;
  error?: string;
  retcode?: number;
}

/**
 * Equivalent names for the same instrument across brokers. Used when a plain
 * suffix match fails — e.g. a strategy configured for `XAUUSD` on a broker
 * that lists gold as `GOLD`. Matching is bidirectional (any name in a group
 * resolves to whichever the broker actually offers) and suffix-tolerant.
 */
const SYMBOL_ALIASES: string[][] = [
  ["XAUUSD", "GOLD"],
  ["XAGUSD", "SILVER"],
  ["US30", "DJ30", "DOW", "WS30", "DJI30"],
  ["NAS100", "USTEC", "USNAS100", "USTECH", "NDX100"],
  ["US500", "SPX500", "SP500", "SPX"],
  ["DE40", "GER40", "DE30", "GER30", "DAX40", "DAX"],
  ["UK100", "FTSE100", "FTSE"],
  ["JP225", "JPN225", "NIKKEI225", "NIKKEI"],
  ["USOIL", "WTI", "XTIUSD", "CRUDE", "OILUSD"],
  ["UKOIL", "BRENT", "XBRUSD"],
];

/** Best broker symbol for a request via exact/suffix match, or null. */
function findBrokerSymbol(requested: string, available: string[]): string | null {
  if (!available.length) return null;
  const want = requested.toUpperCase();
  const exact = available.find((s) => s === requested) ?? available.find((s) => s.toUpperCase() === want);
  if (exact) return exact;
  // Only a separator-prefixed tag or a short LOWERCASE tag counts as a broker
  // suffix, so `BTCUSD` never silently resolves to `BTCUSDT` (a different pair).
  const isBrokerTag = (tag: string) => /^[._-][A-Za-z0-9]{1,5}$/.test(tag) || /^[a-z]{1,5}$/.test(tag);
  const matches = available
    .filter((s) => s.toUpperCase().startsWith(want) && isBrokerTag(s.slice(requested.length)))
    .sort((a, b) => a.length - b.length); // prefer the shortest tag
  return matches[0] ?? null;
}

/**
 * Map a requested symbol to the broker's actual tradeable name. Handles both
 * broker suffixes (`EURUSD` → `EURUSDm`) and cross-broker name differences
 * (`XAUUSD` ↔ `GOLD`, `NAS100` ↔ `USTEC`). Returns the original when nothing
 * matches — let the bridge 404 rather than guess wrong.
 */
export function matchBrokerSymbol(requested: string, available: string[]): string {
  const direct = findBrokerSymbol(requested, available);
  if (direct) return direct;

  const core = requested.toUpperCase().replace(/[._-].*$/, "");
  const group = SYMBOL_ALIASES.find((g) => g.some((a) => core === a || core.startsWith(a)));
  if (group) {
    for (const alias of group) {
      if (core === alias) continue; // already tried as the request
      const hit = findBrokerSymbol(alias, available);
      if (hit) return hit;
    }
  }
  return requested;
}

let brokerSymbolCache: { list: string[]; ts: number } | null = null;
async function brokerSymbols(): Promise<string[]> {
  if (brokerSymbolCache && Date.now() - brokerSymbolCache.ts < 10 * 60_000) return brokerSymbolCache.list;
  try {
    const list = await readBridge<{ symbols: string[] }>("/symbols").then((r) => r.symbols);
    brokerSymbolCache = { list, ts: Date.now() };
    return list;
  } catch {
    return brokerSymbolCache?.list ?? [];
  }
}

/** Resolve a requested symbol to the broker's name (cached symbol list). */
async function resolveSymbol(symbol: string): Promise<string> {
  return matchBrokerSymbol(symbol, await brokerSymbols());
}

type BridgeInit = Omit<RequestInit, "body"> & { body?: string; timeoutMs?: number };

async function bridge<T>(path: string, init?: BridgeInit): Promise<T> {
  const url = `${config.MT5_BRIDGE_URL}${path}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": config.MT5_BRIDGE_API_KEY,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(init?.timeoutMs ?? 15000),
    });
    const json = (await res.json()) as T & { error?: string };
    logger.debug({ path, ms: Date.now() - started, status: res.status }, "mt5 bridge call");
    if (!res.ok) throw new Error(json.error ?? `bridge ${path} failed: ${res.status}`);
    return json;
  } catch (err) {
    await logError("mt5-bridge", `bridge call failed: ${path}`, { error: String(err) });
    throw err;
  }
}

async function readBridge<T>(path: string, init?: Omit<BridgeInit, "body" | "method">): Promise<T> {
  try {
    const result = await withResilience("mt5", () => bridge<T>(path, init), {
      retries: 2,
      baseDelayMs: 250,
      maxDelayMs: 1000,
      failureThreshold: 3,
      cooldownMs: 30_000,
    });
    await resolveIncidentByDedupeKey("mt5:circuit-open", "system").catch(() => undefined);
    return result;
  } catch (error) {
    const state = circuitSnapshot("mt5");
    if (error instanceof CircuitOpenError || (!Array.isArray(state) && state?.status === "open")) {
      await reportIncident({
        dedupeKey: "mt5:circuit-open",
        severity: "CRITICAL",
        source: "mt5",
        title: "MT5 bridge circuit open",
        message: "New broker reads are temporarily blocked after repeated bridge failures.",
        context: { path, error: String(error) },
        minIntervalMs: 60_000,
      }).catch(() => undefined);
    }
    throw error;
  }
}

export const mt5 = {
  health: () => readBridge<{ ok: boolean; mock: boolean; connected: boolean }>("/health"),
  accountInfo: () => readBridge<AccountInfo>("/account"),
  positions: () => readBridge<{ positions: Position[] }>("/positions").then((r) => r.positions),
  history: (days = 30) =>
    readBridge<{ deals: unknown[] }>(`/history?days=${days}`).then((r) => r.deals),
  async tick(symbol: string) {
    return readBridge<Tick>(`/tick/${encodeURIComponent(await resolveSymbol(symbol))}`);
  },
  async candles(symbol: string, timeframe: string, count = 200) {
    const sym = await resolveSymbol(symbol);
    return readBridge<{ candles: Candle[] }>(
      `/candles/${encodeURIComponent(sym)}?timeframe=${timeframe}&count=${count}`,
      // Large history requests trigger an MT5 server download on first use.
      { timeoutMs: count > 1000 ? 120_000 : 15_000 },
    ).then((r) => r.candles);
  },
  async symbolInfo(symbol: string) {
    const sym = await resolveSymbol(symbol);
    return readBridge<BrokerSymbolInfo>(`/symbol/${encodeURIComponent(sym)}`).then(mapBrokerSymbolInfo);
  },
  symbols: () => readBridge<{ symbols: string[] }>("/symbols").then((r) => r.symbols),
  /** Expose the resolver so callers can normalize a symbol once if needed. */
  resolveSymbol,

  /** Switch the terminal to another account. Password is never logged. */
  async connect(
    creds: { login: string; password: string; server: string },
    actor: string,
  ): Promise<{ ok: boolean; login?: string; is_demo?: boolean; balance?: number; currency?: string; error?: string }> {
    await audit({ actor, category: "mt5", action: "account_switch_request", detail: { login: creds.login, server: creds.server } });
    const result = await bridge<{ ok: boolean; login?: string; is_demo?: boolean; balance?: number; currency?: string; error?: string }>("/connect", {
      method: "POST",
      body: JSON.stringify({ login: Number(creds.login), password: creds.password, server: creds.server }),
    });
    await audit({
      actor, category: "mt5", action: "account_switch_result",
      detail: { login: creds.login, server: creds.server, ok: result.ok, is_demo: result.is_demo, error: result.error },
    });
    return result;
  },

  async placeOrder(req: OrderRequest, actor: string): Promise<OrderResult> {
    // Resolve to the broker's real symbol so the order doesn't fail when the
    // strategy/scanner used an un-suffixed name. Record any remap.
    const brokerSymbol = await resolveSymbol(req.symbol);
    const sent = { ...req, symbol: brokerSymbol };
    await audit({ actor, category: "mt5", action: "order_request", detail: { ...sent, requestedSymbol: req.symbol } });
    const result = await bridge<OrderResult>("/order", {
      method: "POST",
      body: JSON.stringify(sent),
    });
    await audit({ actor, category: "mt5", action: "order_result", detail: { req: sent, requestedSymbol: req.symbol, result } });
    return result;
  },

  async modifyPosition(
    ticket: string,
    changes: { sl?: number; tp?: number },
    actor: string,
  ): Promise<OrderResult> {
    await audit({ actor, category: "mt5", action: "modify_request", detail: { ticket, changes } });
    const result = await bridge<OrderResult>(`/position/${ticket}/modify`, {
      method: "POST",
      body: JSON.stringify(changes),
    });
    await audit({ actor, category: "mt5", action: "modify_result", detail: { ticket, result } });
    return result;
  },

  async closePosition(ticket: string, actor: string): Promise<OrderResult> {
    await audit({ actor, category: "mt5", action: "close_request", detail: { ticket } });
    const result = await bridge<OrderResult>(`/position/${ticket}/close`, { method: "POST" });
    await audit({ actor, category: "mt5", action: "close_result", detail: { ticket, result } });
    return result;
  },
};
