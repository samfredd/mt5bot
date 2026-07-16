import { getOperationalConfig } from "../system/operational-config.js";
import { formatTelegramHtml, splitTelegramMarkdown } from "./format.js";

/** Minimal direct send helper (used by notifications, independent of grammY runner). */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const settings = await getOperationalConfig();
  if (!settings.telegramBotToken) throw new Error("Telegram bot token not configured");
  for (const chunk of splitTelegramMarkdown(text)) {
    const res = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formatTelegramHtml(chunk), parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`telegram sendMessage failed: ${res.status}`);
  }
}
