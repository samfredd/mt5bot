import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";
import { audit, logError } from "../../lib/audit.js";

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
}

export interface Position {
  ticket: string;
  symbol: string;
  type: "buy" | "sell";
  volume: number;
  price_open: number;
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
  price?: number;
  error?: string;
  retcode?: number;
}

async function bridge<T>(path: string, init?: RequestInit & { body?: string }): Promise<T> {
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
      signal: AbortSignal.timeout(15000),
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

export const mt5 = {
  health: () => bridge<{ ok: boolean; mock: boolean; connected: boolean }>("/health"),
  accountInfo: () => bridge<AccountInfo>("/account"),
  positions: () => bridge<{ positions: Position[] }>("/positions").then((r) => r.positions),
  history: (days = 30) =>
    bridge<{ deals: unknown[] }>(`/history?days=${days}`).then((r) => r.deals),
  tick: (symbol: string) => bridge<Tick>(`/tick/${encodeURIComponent(symbol)}`),
  candles: (symbol: string, timeframe: string, count = 200) =>
    bridge<{ candles: Candle[] }>(
      `/candles/${encodeURIComponent(symbol)}?timeframe=${timeframe}&count=${count}`,
    ).then((r) => r.candles),
  symbols: () => bridge<{ symbols: string[] }>("/symbols").then((r) => r.symbols),

  async placeOrder(req: OrderRequest, actor: string): Promise<OrderResult> {
    await audit({ actor, category: "mt5", action: "order_request", detail: { ...req } });
    const result = await bridge<OrderResult>("/order", {
      method: "POST",
      body: JSON.stringify(req),
    });
    await audit({ actor, category: "mt5", action: "order_result", detail: { req, result } });
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
