import { Bot, type Context } from "grammy";
import { config } from "../../config.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { mt5 } from "../mt5/client.js";
import { getBotState, setBotState } from "../system/state.js";
import { decideTrade, emergencyStopAll } from "../trading/service.js";
import { latestNews } from "../news/service.js";
import { requireTwoFactor } from "../auth/service.js";

/**
 * Telegram connector. Security model:
 *  - Optional global allowlist (TELEGRAM_ALLOWED_IDS).
 *  - Every account must be linked+verified via /link <code> (code generated
 *    in the dashboard) before any command works.
 *  - Dangerous commands require explicit confirmation; live-trading actions
 *    additionally require a TOTP token appended to the command.
 *  - Every command is audit-logged. Unauthorized commands are rejected+logged.
 */

const pendingConfirm = new Map<string, { action: string; arg?: string; expires: number }>();

async function linkedUser(ctx: Context) {
  const tgId = String(ctx.from?.id ?? "");
  if (!tgId) return null;
  const allow = config.TELEGRAM_ALLOWED_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(tgId)) return null;
  const link = await prisma.telegramUser.findUnique({ where: { telegramId: tgId }, include: { user: true } });
  return link?.verified ? link : null;
}

async function guard(ctx: Context, command: string) {
  const link = await linkedUser(ctx);
  await audit({
    actor: `telegram:${ctx.from?.id}`, userId: link?.userId,
    category: "telegram", action: "command", detail: { command, authorized: !!link },
  });
  if (!link) {
    await ctx.reply("Unauthorized. Link your account first: generate a code in the web dashboard, then send /link <code>.");
    return null;
  }
  return link;
}

export function createTelegramBot(): Bot | null {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — telegram connector disabled");
    return null;
  }
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  bot.command("start", (ctx) =>
    ctx.reply("MT5 AI Trading Bot.\nLink your account with /link <code> (code from the dashboard).\nThen try /status."));

  bot.command("link", async (ctx) => {
    const code = ctx.match?.trim();
    const tgId = String(ctx.from?.id ?? "");
    if (!code) return ctx.reply("Usage: /link <code>");
    const pending = await prisma.telegramUser.findFirst({ where: { linkCode: code, verified: false } });
    if (!pending) return ctx.reply("Invalid or expired link code.");
    await prisma.telegramUser.update({
      where: { id: pending.id },
      data: { telegramId: tgId, chatId: String(ctx.chat?.id), verified: true, linkCode: null },
    });
    await audit({ actor: `telegram:${tgId}`, userId: pending.userId, category: "telegram", action: "account_linked" });
    return ctx.reply("✅ Linked and verified. Try /status.");
  });

  bot.command("status", async (ctx) => {
    const link = await guard(ctx, "/status"); if (!link) return;
    const [state, acc, positions] = await Promise.all([getBotState(), mt5.accountInfo(), mt5.positions()]);
    const pnl = positions.reduce((a, p) => a + p.profit, 0);
    await ctx.reply(
      `🤖 Bot: ${state.status} | mode: ${state.mode} | ${state.demoMode ? "DEMO" : "LIVE"}\n` +
      `💰 Balance: ${acc.balance.toFixed(2)} ${acc.currency} | Equity: ${acc.equity.toFixed(2)}\n` +
      `📊 Margin level: ${acc.margin_level.toFixed(1)}% | Open: ${positions.length} | Floating P/L: ${pnl.toFixed(2)}`);
  });

  bot.command("open_trades", async (ctx) => {
    const link = await guard(ctx, "/open_trades"); if (!link) return;
    const positions = await mt5.positions();
    if (!positions.length) return ctx.reply("No open trades.");
    await ctx.reply(positions.map((p) =>
      `#${p.ticket} ${p.type.toUpperCase()} ${p.symbol} ${p.volume} lots @ ${p.price_open} | P/L ${p.profit.toFixed(2)}`).join("\n"));
  });

  bot.command("profit", async (ctx) => {
    const link = await guard(ctx, "/profit"); if (!link) return;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const agg = await prisma.trade.aggregate({ _sum: { profit: true }, where: { userId: link.userId, closedAt: { gte: dayStart } } });
    const positions = await mt5.positions();
    const floating = positions.reduce((a, p) => a + p.profit, 0);
    await ctx.reply(`Today's closed P/L: ${(agg._sum.profit ?? 0).toFixed(2)}\nFloating P/L: ${floating.toFixed(2)}`);
  });

  bot.command("news", async (ctx) => {
    const link = await guard(ctx, "/news"); if (!link) return;
    const events = await latestNews(8);
    if (!events.length) return ctx.reply("No notable events in the next 24h.");
    await ctx.reply(events.map((e) => `${e.impact === "HIGH" ? "🔴" : e.impact === "MEDIUM" ? "🟠" : "⚪"} ${e.eventTime.toISOString().slice(5, 16)} ${e.currency ?? ""} ${e.title}`).join("\n"));
  });

  bot.command("pause_bot", async (ctx) => {
    const link = await guard(ctx, "/pause_bot"); if (!link) return;
    await setBotState({ status: "paused" }, `telegram:${ctx.from?.id}`);
    await ctx.reply("⏸ Bot paused. No new trades will open. /resume_bot to continue.");
  });

  bot.command("resume_bot", async (ctx) => {
    const link = await guard(ctx, "/resume_bot"); if (!link) return;
    const state = await getBotState();
    if (state.emergencyStop) return ctx.reply("Emergency stop is active — clear it from the dashboard first.");
    await setBotState({ status: "running" }, `telegram:${ctx.from?.id}`);
    await ctx.reply("▶️ Bot resumed.");
  });

  bot.command("emergency_stop", async (ctx) => {
    const link = await guard(ctx, "/emergency_stop"); if (!link) return;
    pendingConfirm.set(String(ctx.from?.id), { action: "emergency_stop", expires: Date.now() + 60_000 });
    await ctx.reply("⚠️ This halts the bot AND closes ALL open positions.\nSend /confirm within 60s to proceed.");
  });

  bot.command("confirm", async (ctx) => {
    const link = await guard(ctx, "/confirm"); if (!link) return;
    const pending = pendingConfirm.get(String(ctx.from?.id));
    if (!pending || pending.expires < Date.now()) return ctx.reply("Nothing to confirm (or it expired).");
    pendingConfirm.delete(String(ctx.from?.id));
    if (pending.action === "emergency_stop") {
      const closed = await emergencyStopAll(`telegram:${ctx.from?.id}`, link.userId);
      return ctx.reply(`🛑 EMERGENCY STOP active. Closed ${closed.length} position(s).`);
    }
  });

  // /approve_trade <id> [lots] [totp] — choose your size; TOTP required in live mode.
  // 6-digit tokens are treated as 2FA codes, anything else numeric as lot size.
  bot.command("approve_trade", async (ctx) => {
    const link = await guard(ctx, "/approve_trade"); if (!link) return;
    const [tradeId, ...rest] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (!tradeId) return ctx.reply("Usage: /approve_trade <trade_id> [lots] [2fa_code]\nExample: /approve_trade abc123 0.05");
    let lots: number | undefined;
    let totp: string | undefined;
    for (const arg of rest) {
      if (/^\d{6}$/.test(arg)) totp = arg;
      else if (!Number.isNaN(Number(arg))) lots = Number(arg);
    }
    const state = await getBotState();
    if (!state.demoMode || state.liveTradingEnabled) {
      const ok = await requireTwoFactor(link.userId, totp);
      if (!ok) return ctx.reply("Live mode: append a valid 2FA code — /approve_trade <id> [lots] <code>");
    }
    const result = await decideTrade(tradeId, true, `telegram:${ctx.from?.id}`, "TELEGRAM", { lots });
    await ctx.reply(result.message);
  });

  bot.command("reject_trade", async (ctx) => {
    const link = await guard(ctx, "/reject_trade"); if (!link) return;
    const tradeId = (ctx.match ?? "").trim();
    if (!tradeId) return ctx.reply("Usage: /reject_trade <trade_id>");
    const result = await decideTrade(tradeId, false, `telegram:${ctx.from?.id}`, "TELEGRAM");
    await ctx.reply(result.message);
  });

  bot.command("copy_trader", async (ctx) => {
    const link = await guard(ctx, "/copy_trader"); if (!link) return;
    const traders = await prisma.copyTrader.findMany({ where: { userId: link.userId } });
    if (!traders.length) return ctx.reply("No copy traders configured. Add them in the dashboard.");
    await ctx.reply(traders.map((t) => `${t.active ? "🟢" : "⚪"} ${t.name} — risk score ${t.riskScore}/100`).join("\n"));
  });

  bot.command("settings", async (ctx) => {
    const link = await guard(ctx, "/settings"); if (!link) return;
    const rs = await prisma.riskSettings.findUnique({ where: { userId: link.userId } });
    if (!rs) return ctx.reply("No risk settings found.");
    await ctx.reply(
      `Risk/trade: ${rs.maxRiskPerTradePct}% | Daily loss cap: ${rs.maxDailyLossPct}%\n` +
      `Max open: ${rs.maxOpenTrades} | Max lot: ${rs.maxLotSize} | Min R:R ${rs.minRiskReward}\n` +
      `News limit: ${rs.newsRiskLimit} | SL required: ${rs.requireStopLoss}\n` +
      `(Change settings in the web dashboard.)`);
  });

  bot.catch((err) => logger.error({ err: String(err.error) }, "telegram bot error"));
  return bot;
}
