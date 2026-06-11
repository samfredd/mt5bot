import { config } from "../../config.js";

/** Minimal direct send helper (used by notifications, independent of grammY runner). */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot token not configured");
  const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`telegram sendMessage failed: ${res.status}`);
}
