import { getOperationalConfig } from "../system/operational-config.js";

export interface TelegramBotProfile { id: string; username: string; displayName: string; }

let cached: { value: TelegramBotProfile | null; ts: number } | null = null;

export async function getTelegramBotProfile(): Promise<TelegramBotProfile | null> {
  if (cached && Date.now() - cached.ts < 60_000) return cached.value;
  const { telegramBotToken } = await getOperationalConfig();
  if (!telegramBotToken) return null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/getMe`, { signal: AbortSignal.timeout(5000) });
    const payload = await response.json() as { ok?: boolean; result?: { id?: number; username?: string; first_name?: string } };
    const value = response.ok && payload.ok && payload.result?.id && payload.result.username
      ? { id: String(payload.result.id), username: payload.result.username, displayName: payload.result.first_name ?? payload.result.username }
      : null;
    cached = { value, ts: Date.now() };
    return value;
  } catch {
    cached = { value: null, ts: Date.now() };
    return null;
  }
}
