import { z } from "zod";
import { generateJson } from "../ai/service.js";

/**
 * Parses human trading signals — the messy messages real traders post in
 * Telegram channels — into structured trade intents. Fast regex pass first;
 * the local AI handles anything the regex can't.
 */

export interface ParsedSignal {
  symbol: string;
  direction: "buy" | "sell";
  entry?: number;
  sl?: number;
  tp?: number;
  lots?: number;
}

const SYMBOL_ALIASES: Record<string, string> = {
  GOLD: "XAUUSD", XAU: "XAUUSD", SILVER: "XAGUSD", XAG: "XAGUSD",
  DOW: "US30", DJ30: "US30", NASDAQ: "NAS100", NDX: "NAS100",
  SP500: "US500", SPX: "US500", BITCOIN: "BTCUSD", BTC: "BTCUSD", ETH: "ETHUSD",
};

export function normalizeSymbol(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[\s/\-_]/g, "");
  return SYMBOL_ALIASES[cleaned] ?? cleaned;
}

/** Does this text even loosely look like a trade signal? Cheap pre-filter. */
export function looksLikeSignal(text: string): boolean {
  return /\b(buy|sell|long|short)\b/i.test(text) &&
    /\b([A-Z]{6}|XAU\s?USD|GOLD|SILVER|US30|NAS100|US500|BTC\s?USD|ETH\s?USD|[A-Z]{3}\s?\/\s?[A-Z]{3})\b/i.test(text);
}

export function parseSignalRegex(text: string): ParsedSignal | null {
  const dirMatch = text.match(/\b(buy|sell|long|short)\b/i);
  if (!dirMatch) return null;
  const direction = /buy|long/i.test(dirMatch[1]) ? "buy" : "sell";

  const symMatch = text.match(/\b([A-Z]{3}\s?\/\s?[A-Z]{3}|[A-Z]{6,7}|XAU\s?USD|GOLD|SILVER|US30|NAS100|US500|BTC\s?USD|ETH\s?USD)\b/i);
  if (!symMatch) return null;
  const symbol = normalizeSymbol(symMatch[1]);

  const num = (re: RegExp): number | undefined => {
    const m = text.match(re);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : undefined;
  };

  const sl = num(/(?:sl|stop\s?loss|stop)\s*[:@=]?\s*([0-9]+(?:[.,][0-9]+)?)/i);
  // \b after the optional "1" stops "tp 191.00" being read as "tp1" + "91.00"
  const tp = num(/(?:tp|take\s?profit|target)\s?1?\b\s*[:@=]?\s*([0-9]+(?:[.,][0-9]+)?)/i);
  const entry = num(/(?:entry|open|@|\bat\b)\s*[:=]?\s*([0-9]+(?:[.,][0-9]+)?)/i);
  const lots = num(/([0-9]+(?:\.[0-9]+)?)\s*lots?\b/i);

  return { symbol, direction, entry, sl, tp, lots };
}

const AiSignalSchema = z.object({
  is_signal: z.boolean(),
  symbol: z.string().nullable(),
  direction: z.enum(["buy", "sell"]).nullable(),
  entry: z.number().nullable(),
  stop_loss: z.number().nullable(),
  take_profit: z.number().nullable(),
  lots: z.number().nullable(),
});

export async function parseSignalAi(text: string): Promise<ParsedSignal | null> {
  const raw = await generateJson(
    [
      `Extract a trading signal from this message. If it is not a trade signal, set is_signal=false.`,
      `Message: """${text.slice(0, 800)}"""`,
      `Respond ONLY with JSON: {"is_signal":bool,"symbol":"EURUSD|XAUUSD|...","direction":"buy|sell","entry":number|null,"stop_loss":number|null,"take_profit":number|null,"lots":number|null}`,
    ].join("\n"),
  );
  const parsed = AiSignalSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.is_signal || !parsed.data.symbol || !parsed.data.direction) return null;
  return {
    symbol: normalizeSymbol(parsed.data.symbol),
    direction: parsed.data.direction,
    entry: parsed.data.entry ?? undefined,
    sl: parsed.data.stop_loss ?? undefined,
    tp: parsed.data.take_profit ?? undefined,
    lots: parsed.data.lots ?? undefined,
  };
}

/** Regex first (fast, free), AI fallback for messy human phrasing. */
export async function parseSignal(text: string): Promise<ParsedSignal | null> {
  const quick = parseSignalRegex(text);
  if (quick?.sl || quick?.tp) return quick; // confident parse
  const ai = await parseSignalAi(text);
  return ai ?? quick;
}
