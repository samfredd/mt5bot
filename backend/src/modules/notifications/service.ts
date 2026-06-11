import { prisma } from "../../lib/prisma.js";
import { config } from "../../config.js";
import { logError } from "../../lib/audit.js";
import { broadcast } from "../ws/hub.js";
import { sendTelegramMessage } from "../telegram/send.js";

export type NotifyType =
  | "trade_opened"
  | "trade_closed"
  | "stop_loss_hit"
  | "take_profit_hit"
  | "margin_warning"
  | "drawdown_warning"
  | "daily_loss_warning"
  | "news_alert"
  | "bot_paused"
  | "bot_resumed"
  | "emergency_stop"
  | "copy_update"
  | "risk_violation"
  | "ai_avoid"
  | "approval_request"
  | "system_error"
  | "daily_report";

/**
 * Fans an event out to every channel the user has enabled. Each channel
 * failure is isolated — one broken connector never blocks the others.
 */
export async function notify(
  userId: string,
  type: NotifyType,
  title: string,
  body: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { telegramUsers: { where: { verified: true } }, whatsappUsers: { where: { verified: true } } },
  });
  if (!user) return;
  const prefs = (user.notificationPrefs ?? {}) as Record<string, boolean>;

  // Web dashboard — always on.
  broadcast("notification", { type, title, body });
  await record(userId, "WEB", type, title, body, "sent");

  if (prefs.telegram !== false && user.telegramUsers.length) {
    for (const tg of user.telegramUsers) {
      try {
        if (tg.chatId) await sendTelegramMessage(tg.chatId, `*${title}*\n${body}`);
        await record(userId, "TELEGRAM", type, title, body, "sent");
      } catch (err) {
        await record(userId, "TELEGRAM", type, title, body, "failed");
        await logError("notifications", "telegram send failed", { error: String(err) });
      }
    }
  }

  if (prefs.whatsapp !== false && user.whatsappUsers.length && config.TWILIO_ACCOUNT_SID) {
    for (const wa of user.whatsappUsers) {
      try {
        await sendWhatsapp(wa.phone, `${title}\n${body}`);
        await record(userId, "WHATSAPP", type, title, body, "sent");
      } catch (err) {
        await record(userId, "WHATSAPP", type, title, body, "failed");
        await logError("notifications", "whatsapp send failed", { error: String(err) });
      }
    }
  }
}

async function record(
  userId: string,
  channel: "WEB" | "TELEGRAM" | "WHATSAPP" | "EMAIL",
  type: string,
  title: string,
  body: string,
  status: string,
) {
  await prisma.notification.create({
    data: { userId, channel, type, title, body, status, sentAt: status === "sent" ? new Date() : null },
  });
}

/** Outbound WhatsApp via the Twilio API. */
export async function sendWhatsapp(phone: string, body: string): Promise<void> {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured");
  }
  const to = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
  const auth = Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: config.TWILIO_WHATSAPP_FROM, To: to, Body: body }).toString(),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`twilio returned ${res.status}: ${await res.text()}`);
}
