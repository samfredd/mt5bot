import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { mt5 } from "../mt5/client.js";
import { currentAccountId } from "../mt5/account.js";
import { getBotState, setBotState } from "../system/state.js";
import { decideTrade, emergencyStopAll } from "../trading/service.js";
import { latestNews } from "../news/service.js";
import { requireTwoFactor } from "../auth/service.js";

/**
 * WhatsApp connector via Twilio webhooks. Plain-text command interface.
 * Same security model as Telegram: phone must be linked+verified, dangerous
 * commands need a typed confirmation, live approvals need a TOTP code.
 */

const pendingConfirm = new Map<string, { action: string; expires: number }>();

function twiml(message: string): string {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

/** Validate X-Twilio-Signature so forged webhooks are rejected. */
function validTwilioSignature(url: string, params: Record<string, string>, signature: string): boolean {
  if (!config.TWILIO_AUTH_TOKEN) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", config.TWILIO_AUTH_TOKEN).update(data).digest("base64");
  return expected === signature;
}

export async function whatsappRoutes(app: FastifyInstance) {
  app.post("/webhooks/whatsapp", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const from = (body.From ?? "").replace("whatsapp:", "");
    const text = (body.Body ?? "").trim().toLowerCase();

    // Signature check (skippable only in development for local testing).
    const sig = req.headers["x-twilio-signature"] as string | undefined;
    const fullUrl = `${req.protocol}://${req.hostname}${req.url}`;
    if (config.NODE_ENV === "production" && (!sig || !validTwilioSignature(fullUrl, body, sig))) {
      await audit({ actor: `whatsapp:${from}`, category: "whatsapp", action: "invalid_signature" });
      return reply.code(403).send("invalid signature");
    }

    const link = await prisma.whatsappUser.findUnique({ where: { phone: from }, include: { user: true } });

    // Linking flow: "link <code>"
    if (text.startsWith("link ")) {
      const code = text.slice(5).trim();
      const pending = await prisma.whatsappUser.findFirst({ where: { linkCode: code, verified: false } });
      if (!pending) return reply.type("text/xml").send(twiml("Invalid or expired link code."));
      await prisma.whatsappUser.update({ where: { id: pending.id }, data: { phone: from, verified: true, linkCode: null } });
      await audit({ actor: `whatsapp:${from}`, userId: pending.userId, category: "whatsapp", action: "account_linked" });
      return reply.type("text/xml").send(twiml("✅ Linked and verified. Send 'status' to begin."));
    }

    await audit({ actor: `whatsapp:${from}`, userId: link?.userId, category: "whatsapp", action: "command", detail: { text, authorized: !!link?.verified } });
    if (!link?.verified) {
      return reply.type("text/xml").send(twiml("Unauthorized. Generate a link code in the dashboard, then send: link <code>"));
    }
    const userId = link.userId;

    const respond = (msg: string) => reply.type("text/xml").send(twiml(msg));

    if (text === "status") {
      const [state, acc, positions] = await Promise.all([getBotState(), mt5.accountInfo(), mt5.positions()]);
      return respond(`Bot: ${state.status} (${state.mode}, ${state.demoMode ? "DEMO" : "LIVE"})\nBalance ${acc.balance.toFixed(2)} | Equity ${acc.equity.toFixed(2)}\nOpen trades: ${positions.length}`);
    }
    if (text === "open trades") {
      const positions = await mt5.positions();
      return respond(positions.length
        ? positions.map((p) => `#${p.ticket} ${p.type.toUpperCase()} ${p.symbol} ${p.volume} P/L ${p.profit.toFixed(2)}`).join("\n")
        : "No open trades.");
    }
    if (text === "today's profit" || text === "todays profit") {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      // Per-account: today's P/L for the account the terminal is on.
      const accountId = await currentAccountId(userId);
      const agg = await prisma.trade.aggregate({
        _sum: { profit: true },
        where: { userId, closedAt: { gte: dayStart }, ...(accountId ? { accountId } : {}) },
      });
      return respond(`Today's closed P/L: ${(agg._sum.profit ?? 0).toFixed(2)}`);
    }
    if (text === "latest news") {
      const events = await latestNews(6);
      return respond(events.length
        ? events.map((e) => `[${e.impact}] ${e.eventTime.toISOString().slice(5, 16)} ${e.currency ?? ""} ${e.title}`).join("\n")
        : "No notable events in the next 24h.");
    }
    if (text === "pause bot") {
      await setBotState({ status: "paused" }, `whatsapp:${from}`);
      return respond("⏸ Bot paused.");
    }
    if (text === "resume bot") {
      const state = await getBotState();
      if (state.emergencyStop) return respond("Emergency stop active — clear it from the dashboard first.");
      await setBotState({ status: "running" }, `whatsapp:${from}`);
      return respond("▶️ Bot resumed.");
    }
    if (text === "emergency stop") {
      pendingConfirm.set(from, { action: "emergency_stop", expires: Date.now() + 60_000 });
      return respond("⚠️ This halts the bot and closes ALL positions. Reply CONFIRM within 60s.");
    }
    if (text === "confirm") {
      const pending = pendingConfirm.get(from);
      if (!pending || pending.expires < Date.now()) return respond("Nothing to confirm (or it expired).");
      pendingConfirm.delete(from);
      const closed = await emergencyStopAll(`whatsapp:${from}`, userId);
      return respond(`🛑 EMERGENCY STOP active. Closed ${closed.length} position(s).`);
    }
    if (text.startsWith("approve trade")) {
      const parts = text.split(/\s+/); // approve trade <id> [lots] [totp]
      const tradeId = parts[2];
      if (!tradeId) return respond("Usage: approve trade <id> [lots] [2fa code]\nExample: approve trade abc123 0.05");
      let lots: number | undefined;
      let totp: string | undefined;
      for (const arg of parts.slice(3)) {
        if (/^\d{6}$/.test(arg)) totp = arg;
        else if (!Number.isNaN(Number(arg))) lots = Number(arg);
      }
      const state = await getBotState();
      if (!state.demoMode || state.liveTradingEnabled) {
        const ok = await requireTwoFactor(userId, totp);
        if (!ok) return respond("Live mode: include your 2FA code — approve trade <id> [lots] <code>");
      }
      const result = await decideTrade(tradeId, true, `whatsapp:${from}`, "WHATSAPP", { lots });
      return respond(result.message);
    }
    if (text.startsWith("reject trade")) {
      const tradeId = text.split(/\s+/)[2];
      if (!tradeId) return respond("Usage: reject trade <id>");
      const result = await decideTrade(tradeId, false, `whatsapp:${from}`, "WHATSAPP");
      return respond(result.message);
    }
    if (text === "copy trading status") {
      const traders = await prisma.copyTrader.findMany({ where: { userId } });
      return respond(traders.length
        ? traders.map((t) => `${t.active ? "ON " : "off"} ${t.name} (risk ${t.riskScore}/100)`).join("\n")
        : "No copy traders configured.");
    }

    return respond("Commands: status | open trades | today's profit | latest news | pause bot | resume bot | emergency stop | approve trade <id> | reject trade <id> | copy trading status");
  });
}
