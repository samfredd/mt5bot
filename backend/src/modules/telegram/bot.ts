import { Bot, InlineKeyboard, type Context } from "grammy";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { mt5 } from "../mt5/client.js";
import { currentAccountId } from "../mt5/account.js";
import { getBotState, setBotState } from "../system/state.js";
import { decideTrade, emergencyStopAll } from "../trading/service.js";
import { copySourceTrade } from "../copy/service.js";
import { latestNews } from "../news/service.js";
import { requireTwoFactor } from "../auth/service.js";
import { getOperationalConfig } from "../system/operational-config.js";
import { chatWithAssistant, getAssistantConfig } from "../assistant/service.js";
import { replyTelegram, withTelegramTyping } from "./format.js";

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

export const TELEGRAM_COMMANDS = [
  { command: "menu", description: "Open the trading control menu" },
  { command: "ask", description: "Ask the system assistant" },
  { command: "status", description: "Account and bot status" },
  { command: "open_trades", description: "View open positions" },
  { command: "profit", description: "View today's profit and loss" },
  { command: "news", description: "View upcoming market events" },
  { command: "settings", description: "View current risk settings" },
  { command: "pause_bot", description: "Pause new trade entries" },
  { command: "resume_bot", description: "Resume the trading bot" },
  { command: "emergency_stop", description: "Stop bot and prepare to close positions" },
  { command: "help", description: "Show command help" },
] as const;

function mainMenuKeyboard() {
  return new InlineKeyboard()
    .text("📊 Status", "menu:status").text("📈 Open trades", "menu:open_trades").row()
    .text("💰 Profit & loss", "menu:profit").text("🗓 Market news", "menu:news").row()
    .text("⚙️ Risk settings", "menu:settings").text("🤖 Ask AI", "menu:assistant").row()
    .text("🎛 Bot controls", "menu:controls").text("❓ Help", "menu:help");
}

function controlsKeyboard() {
  return new InlineKeyboard()
    .text("⏸ Pause", "control:pause").text("▶️ Resume", "control:resume").row()
    .text("🛑 Emergency stop", "control:emergency").row()
    .text("⬅️ Main menu", "menu:home");
}

const helpText = `# MT5 AI Bot commands

**Account and analysis**
- /status — bot, account and margin status
- /open_trades — live positions and floating P/L
- /profit — today's closed and floating P/L
- /news — upcoming market-moving events
- /settings — active risk controls

**AI assistant**
- /ask followed by your question
- Or simply send a normal message in this private chat

**Bot controls**
- /pause_bot — prevent new trades
- /resume_bot — resume trading
- /emergency_stop — prepare a protected emergency stop

Use /menu at any time to open the command panel.`;

async function completeTelegramLink(ctx: Context, code: string) {
  const tgId = String(ctx.from?.id ?? "");
  if (!tgId) return replyTelegram(ctx, "Telegram could not identify this account.");
  const allow = (await getOperationalConfig()).telegramAllowedIds;
  if (allow.length && !allow.includes(tgId)) return replyTelegram(ctx, "This Telegram account is not in the allowed-ID list configured in Settings.");
  const pending = await prisma.telegramUser.findFirst({ where: { linkCode: code, verified: false } });
  if (!pending) return replyTelegram(ctx, "Invalid or expired link code. Generate a fresh code in Settings → Connectors.");
  const existing = await prisma.telegramUser.findUnique({ where: { telegramId: tgId } });
  if (existing && existing.userId !== pending.userId) return replyTelegram(ctx, "This Telegram account is already linked to another application user.");
  if (existing) {
    await prisma.$transaction([
      prisma.telegramUser.delete({ where: { id: pending.id } }),
      prisma.telegramUser.update({ where: { id: existing.id }, data: { chatId: String(ctx.chat?.id), verified: true, linkCode: null } }),
    ]);
  } else {
    await prisma.telegramUser.update({ where: { id: pending.id }, data: { telegramId: tgId, chatId: String(ctx.chat?.id), verified: true, linkCode: null } });
  }
  await prisma.telegramUser.deleteMany({ where: { userId: pending.userId, verified: false } });
  await audit({ actor: `telegram:${tgId}`, userId: pending.userId, category: "telegram", action: "account_linked" });
  return replyTelegram(ctx, "# ✅ Linked and verified\n\nYour account is connected. Open /menu to view the command panel, or send a question to the AI assistant.", { reply_markup: mainMenuKeyboard() });
}

async function linkedUser(ctx: Context) {
  const tgId = String(ctx.from?.id ?? "");
  if (!tgId) return null;
  const allow = (await getOperationalConfig()).telegramAllowedIds;
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
    await replyTelegram(ctx, "**Unauthorized.** Link your account first: generate a code in the web dashboard, then send `/link <code>`. ");
    return null;
  }
  return link;
}

export async function createTelegramBot(): Promise<Bot | null> {
  const settings = await getOperationalConfig();
  if (!settings.telegramBotToken) {
    logger.warn("Telegram bot token not configured in Settings — telegram connector disabled");
    return null;
  }
  const bot = new Bot(settings.telegramBotToken);

  await Promise.all([
    bot.api.setMyCommands([...TELEGRAM_COMMANDS]),
    bot.api.setChatMenuButton({ menu_button: { type: "commands" } }),
  ]).catch((error) => logger.warn({ error: String(error) }, "telegram command menu could not be configured"));

  async function showMenu(ctx: Context) {
    const link = await guard(ctx, "/menu"); if (!link) return;
    await replyTelegram(ctx, "# Trading command center\n\nChoose an area below. Read-only information opens immediately; trading controls remain protected and audited.", { reply_markup: mainMenuKeyboard() });
  }

  async function showStatus(ctx: Context) {
    const link = await guard(ctx, "/status"); if (!link) return;
    await withTelegramTyping(ctx, async () => {
      const [state, acc, positions] = await Promise.all([getBotState(), mt5.accountInfo(), mt5.positions()]);
      const pnl = positions.reduce((a, p) => a + p.profit, 0);
      await replyTelegram(ctx,
        `# 🤖 System status\n\n` +
        `**Bot:** ${state.status}\n**Mode:** ${state.mode}\n**Environment:** ${state.demoMode ? "DEMO" : "LIVE"}\n\n` +
        `## Account\n- Balance: **${acc.balance.toFixed(2)} ${acc.currency}**\n- Equity: **${acc.equity.toFixed(2)} ${acc.currency}**\n- Margin level: **${acc.margin_level.toFixed(1)}%**\n- Open positions: **${positions.length}**\n- Floating P/L: **${pnl.toFixed(2)} ${acc.currency}**`,
        { reply_markup: mainMenuKeyboard() });
    });
  }

  async function showOpenTrades(ctx: Context) {
    const link = await guard(ctx, "/open_trades"); if (!link) return;
    await withTelegramTyping(ctx, async () => {
      const positions = await mt5.positions();
      if (!positions.length) return replyTelegram(ctx, "# 📈 Open trades\n\nNo open trades.", { reply_markup: mainMenuKeyboard() });
      await replyTelegram(ctx, `# 📈 Open trades (${positions.length})\n\n${positions.map((p) =>
        `- **${p.type.toUpperCase()} ${p.symbol}** · ${p.volume} lots\n  Ticket: \`${p.ticket}\` · Entry: ${p.price_open} · P/L: **${p.profit.toFixed(2)}**`).join("\n")}`, { reply_markup: mainMenuKeyboard() });
    });
  }

  async function showProfit(ctx: Context) {
    const link = await guard(ctx, "/profit"); if (!link) return;
    await withTelegramTyping(ctx, async () => {
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const accountId = await currentAccountId(link.userId);
      const [agg, positions] = await Promise.all([
        prisma.trade.aggregate({
          _sum: { profit: true },
          where: { userId: link.userId, closedAt: { gte: dayStart }, ...(accountId ? { accountId } : {}) },
        }),
        mt5.positions(),
      ]);
      const floating = positions.reduce((a, p) => a + p.profit, 0);
      await replyTelegram(ctx, `# 💰 Today's profit and loss\n\n- Closed P/L: **${(agg._sum.profit ?? 0).toFixed(2)}**\n- Floating P/L: **${floating.toFixed(2)}**\n- Open positions: **${positions.length}**`, { reply_markup: mainMenuKeyboard() });
    });
  }

  async function showNews(ctx: Context) {
    const link = await guard(ctx, "/news"); if (!link) return;
    await withTelegramTyping(ctx, async () => {
      const events = await latestNews(8);
      if (!events.length) return replyTelegram(ctx, "# 🗓 Market news\n\nNo notable events in the next 24 hours.", { reply_markup: mainMenuKeyboard() });
      await replyTelegram(ctx, `# 🗓 Upcoming market events\n\n${events.map((event) =>
        `- ${event.impact === "HIGH" ? "🔴" : event.impact === "MEDIUM" ? "🟠" : "⚪"} **${event.currency ?? "Market"}** · ${event.eventTime.toISOString().slice(5, 16)}\n  ${event.title}`).join("\n")}`, { reply_markup: mainMenuKeyboard() });
    });
  }

  async function pauseBot(ctx: Context) {
    const link = await guard(ctx, "/pause_bot"); if (!link) return;
    await setBotState({ status: "paused" }, `telegram:${ctx.from?.id}`);
    await replyTelegram(ctx, "# ⏸ Bot paused\n\nNo new trades will open. Use /resume_bot to continue.", { reply_markup: controlsKeyboard() });
  }

  async function resumeBot(ctx: Context) {
    const link = await guard(ctx, "/resume_bot"); if (!link) return;
    const state = await getBotState();
    if (state.emergencyStop) return replyTelegram(ctx, "**Emergency stop is active.** Clear it from the dashboard safety controls first.", { reply_markup: controlsKeyboard() });
    await setBotState({ status: "running" }, `telegram:${ctx.from?.id}`);
    await replyTelegram(ctx, "# ▶️ Bot resumed\n\nThe bot may evaluate and open new trades according to its current mode and safety rules.", { reply_markup: controlsKeyboard() });
  }

  async function prepareEmergencyStop(ctx: Context) {
    const link = await guard(ctx, "/emergency_stop"); if (!link) return;
    pendingConfirm.set(String(ctx.from?.id), { action: "emergency_stop", expires: Date.now() + 60_000 });
    const confirm = new InlineKeyboard().text("🛑 Confirm emergency stop", "confirm:emergency").row().text("Cancel", "menu:controls");
    await replyTelegram(ctx, "# ⚠️ Emergency stop confirmation\n\nThis halts the bot **and closes every open position**. Confirm within 60 seconds to proceed.", { reply_markup: confirm });
  }

  async function confirmPending(ctx: Context) {
    const link = await guard(ctx, "/confirm"); if (!link) return;
    const pending = pendingConfirm.get(String(ctx.from?.id));
    if (!pending || pending.expires < Date.now()) return replyTelegram(ctx, "Nothing to confirm, or the confirmation expired.", { reply_markup: controlsKeyboard() });
    pendingConfirm.delete(String(ctx.from?.id));
    if (pending.action === "emergency_stop") {
      await withTelegramTyping(ctx, async () => {
        const closed = await emergencyStopAll(`telegram:${ctx.from?.id}`, link.userId);
        await replyTelegram(ctx, `# 🛑 Emergency stop active\n\nClosed **${closed.length}** position(s).`, { reply_markup: controlsKeyboard() });
      });
    }
  }

  async function showSettings(ctx: Context) {
    const link = await guard(ctx, "/settings"); if (!link) return;
    const rs = await prisma.riskSettings.findUnique({ where: { userId: link.userId } });
    if (!rs) return replyTelegram(ctx, "No risk settings were found.", { reply_markup: mainMenuKeyboard() });
    await replyTelegram(ctx,
      `# ⚙️ Active risk settings\n\n` +
      `- Risk per trade: **${rs.maxRiskPerTradePct}%**\n- Daily loss cap: **${rs.maxDailyLossPct}%**\n` +
      `- Maximum open trades: **${rs.maxOpenTrades}**\n- Maximum lot: **${rs.maxLotSize}**\n` +
      `- Minimum R:R: **${rs.minRiskReward}**\n- News limit: **${rs.newsRiskLimit}**\n- Stop loss required: **${rs.requireStopLoss ? "Yes" : "No"}**\n\nChange settings from the dashboard or ask the AI assistant to prepare a confirmed change.`,
      { reply_markup: mainMenuKeyboard() });
  }

  bot.command("start", async (ctx) => {
    const payload = (ctx.match ?? "").trim();
    if (payload.startsWith("link_")) return completeTelegramLink(ctx, payload.slice(5));
    const linked = await linkedUser(ctx);
    if (linked) return replyTelegram(ctx, "# MT5 AI Trading Bot\n\nYour account is linked. Use the panel below or send a normal message to the assistant.", { reply_markup: mainMenuKeyboard() });
    return replyTelegram(ctx, "# MT5 AI Trading Bot\n\nLink your account from **Settings → Connectors**, then open /menu or send `/ask <question>`. ");
  });

  bot.command("link", async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return replyTelegram(ctx, "Usage: `/link <code>`");
    return completeTelegramLink(ctx, code);
  });

  bot.command("menu", showMenu);
  bot.command("help", async (ctx) => { const link = await guard(ctx, "/help"); if (link) await replyTelegram(ctx, helpText, { reply_markup: mainMenuKeyboard() }); });
  bot.command("status", showStatus);
  bot.command("open_trades", showOpenTrades);
  bot.command("profit", showProfit);
  bot.command("news", showNews);
  bot.command("pause_bot", pauseBot);
  bot.command("resume_bot", resumeBot);
  bot.command("emergency_stop", prepareEmergencyStop);
  bot.command("confirm", confirmPending);

  // /approve_trade <id> [lots] [totp] — choose your size; TOTP required in live mode.
  // 6-digit tokens are treated as 2FA codes, anything else numeric as lot size.
  bot.command("approve_trade", async (ctx) => {
    const link = await guard(ctx, "/approve_trade"); if (!link) return;
    const [tradeId, ...rest] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (!tradeId) return replyTelegram(ctx, "Usage: `/approve_trade <trade_id> [lots] [2fa_code]`\n\nExample: `/approve_trade abc123 0.05`");
    let lots: number | undefined;
    let totp: string | undefined;
    for (const arg of rest) {
      if (/^\d{6}$/.test(arg)) totp = arg;
      else if (!Number.isNaN(Number(arg))) lots = Number(arg);
    }
    const state = await getBotState();
    let twoFactorVerified = false;
    if (!state.demoMode || state.liveTradingEnabled) {
      twoFactorVerified = await requireTwoFactor(link.userId, totp);
      if (!twoFactorVerified) return replyTelegram(ctx, "**Live mode requires 2FA.**\n\nUse `/approve_trade <id> [lots] <code>`. ");
    }
    const result = await decideTrade(tradeId, true, `telegram:${ctx.from?.id}`, "TELEGRAM", { actorUserId: link.userId, lots, twoFactorVerified });
    await replyTelegram(ctx, result.message);
  });

  bot.command("reject_trade", async (ctx) => {
    const link = await guard(ctx, "/reject_trade"); if (!link) return;
    const tradeId = (ctx.match ?? "").trim();
    if (!tradeId) return replyTelegram(ctx, "Usage: `/reject_trade <trade_id>`");
    const result = await decideTrade(tradeId, false, `telegram:${ctx.from?.id}`, "TELEGRAM", { actorUserId: link.userId });
    await replyTelegram(ctx, result.message);
  });

  bot.command("copy_trader", async (ctx) => {
    const link = await guard(ctx, "/copy_trader"); if (!link) return;
    const traders = await prisma.copyTrader.findMany({ where: { userId: link.userId } });
    if (!traders.length) return replyTelegram(ctx, "No copy traders are configured. Add them from the dashboard.");
    await replyTelegram(ctx, `# Copy traders\n\n${traders.map((t) => `- ${t.active ? "🟢" : "⚪"} **${t.name}** — risk score ${t.riskScore}/100`).join("\n")}`);
  });

  bot.command("settings", showSettings);

  bot.callbackQuery(/^(menu|control|confirm):/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    switch (ctx.callbackQuery.data) {
      case "menu:home": return showMenu(ctx);
      case "menu:status": return showStatus(ctx);
      case "menu:open_trades": return showOpenTrades(ctx);
      case "menu:profit": return showProfit(ctx);
      case "menu:news": return showNews(ctx);
      case "menu:settings": return showSettings(ctx);
      case "menu:assistant": {
        const link = await guard(ctx, "menu:assistant");
        if (link) await replyTelegram(ctx, "# 🤖 AI assistant\n\nSend any normal message, or use `/ask` followed by your question.\n\nExamples:\n- Why has the bot not taken a trade?\n- Explain my current risk settings\n- Summarize today's activity", { reply_markup: mainMenuKeyboard() });
        return;
      }
      case "menu:controls": {
        const link = await guard(ctx, "menu:controls");
        if (link) await replyTelegram(ctx, "# 🎛 Bot controls\n\nChoose an action. Every control is authenticated and audited.", { reply_markup: controlsKeyboard() });
        return;
      }
      case "menu:help": {
        const link = await guard(ctx, "menu:help");
        if (link) await replyTelegram(ctx, helpText, { reply_markup: mainMenuKeyboard() });
        return;
      }
      case "control:pause": return pauseBot(ctx);
      case "control:resume": return resumeBot(ctx);
      case "control:emergency": return prepareEmergencyStop(ctx);
      case "confirm:emergency": return confirmPending(ctx);
    }
  });

  bot.command("ask", async (ctx) => {
    const link = await guard(ctx, "/ask"); if (!link) return;
    const message = (ctx.match ?? "").trim();
    if (!message) return replyTelegram(ctx, "Usage: `/ask <question or requested change>`");
    const settings = await getAssistantConfig();
    if (!settings.telegramEnabled) return replyTelegram(ctx, "Assistant access from Telegram is disabled in Settings.");
    return withTelegramTyping(ctx, async () => {
      const result = await chatWithAssistant({ userId: link.userId, actor: `telegram:${ctx.from?.id}`, role: link.user.role, message, channel: "telegram" });
      const response = result.confirmation
        ? `${result.message}\n\n**Confirmation required**\nReply with \`/assistant_confirm ${result.confirmation.token}\` within 5 minutes.`
        : result.message;
      await replyTelegram(ctx, response, { reply_markup: mainMenuKeyboard() });
    });
  });

  bot.command("assistant_confirm", async (ctx) => {
    const link = await guard(ctx, "/assistant_confirm"); if (!link) return;
    const token = (ctx.match ?? "").trim();
    if (!token) return replyTelegram(ctx, "Usage: `/assistant_confirm <token>`");
    return withTelegramTyping(ctx, async () => {
      const result = await chatWithAssistant({ userId: link.userId, actor: `telegram:${ctx.from?.id}`, role: link.user.role, confirmToken: token, channel: "telegram" });
      await replyTelegram(ctx, result.message, { reply_markup: mainMenuKeyboard() });
    });
  });

  /**
   * Real-trader signal copying: forward any human trader's signal message to
   * this bot (or add the bot to a signal group). The signal is parsed
   * (regex + AI), attributed to the original trader via the forward origin,
   * and routed through that trader's copy rules and the full risk engine.
   */
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // commands handled above
    const isPrivate = ctx.chat?.type === "private";

    const link = await linkedUser(ctx);
    if (!link) return; // never react to strangers (and stay silent in groups)

    const { looksLikeSignal, parseSignal } = await import("../copy/signal-parser.js");
    if (!looksLikeSignal(text)) {
      if (isPrivate) {
        const assistant = await getAssistantConfig();
        if (!assistant.telegramEnabled) return replyTelegram(ctx, "That does not look like a trade signal, and assistant access from Telegram is disabled in Settings.");
        await withTelegramTyping(ctx, async () => {
          const result = await chatWithAssistant({ userId: link.userId, actor: `telegram:${ctx.from?.id}`, role: link.user.role, message: text, channel: "telegram" });
          const response = result.confirmation
            ? `${result.message}\n\n**Confirmation required**\nReply with \`/assistant_confirm ${result.confirmation.token}\` within 5 minutes.`
            : result.message;
          await replyTelegram(ctx, response, { reply_markup: mainMenuKeyboard() });
        });
      }
      return;
    }
    const signal = await parseSignal(text);
    await audit({
      actor: `telegram:${ctx.from?.id}`, userId: link.userId, category: "copy",
      action: "signal_received", detail: { text: text.slice(0, 300), parsed: signal as unknown as Record<string, unknown> },
    });
    if (!signal) {
      if (isPrivate) await replyTelegram(ctx, "I could not extract a clear signal. Include at least a **symbol** and **buy/sell direction**.");
      return;
    }

    // Attribute the signal to the human trader it came from.
    const origin = (ctx.message as unknown as {
      forward_origin?: { type: string; chat?: { title?: string }; sender_user?: { first_name?: string; last_name?: string }; sender_user_name?: string };
    }).forward_origin;
    const traderName =
      origin?.chat?.title ??
      (origin?.sender_user ? `${origin.sender_user.first_name ?? ""} ${origin.sender_user.last_name ?? ""}`.trim() : undefined) ??
      origin?.sender_user_name ??
      (ctx.chat?.type !== "private" ? (ctx.chat as { title?: string }).title : undefined) ??
      "Forwarded signals";

    let trader = await prisma.copyTrader.findFirst({
      where: { userId: link.userId, name: { equals: traderName, mode: "insensitive" } },
    });
    if (!trader) {
      trader = await prisma.copyTrader.create({
        data: {
          userId: link.userId, name: traderName, source: `telegram:${ctx.chat?.id}`,
          active: false, riskScore: 60,
          metrics: { note: "auto-created from Telegram signal — metrics unknown" } as object,
          copyRules: { stopAfterLossStreak: 5, maxSourceLot: 1 } as object,
        },
      });
      await replyTelegram(ctx,
        `# 📡 New trader profile\n\n**${traderName}** was created from this signal's origin.\n\nIt starts **inactive** for safety. Review it and press Copy in the dashboard's Copy Trading tab, then forward the signal again.`);
      return;
    }
    if (!trader.active) {
      await replyTelegram(ctx, `**${trader.name}** is not active. Activate it in the dashboard's Copy Trading tab to copy this signal.`);
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: link.userId } });
    const trade = await copySourceTrade(user!, trader, {
      symbol: signal.symbol, direction: signal.direction, lots: signal.lots,
      sl: signal.sl, tp: signal.tp, ref: `telegram:${ctx.message.message_id}`,
    });
    if (trade && trade.status === "EXECUTED") {
      await replyTelegram(ctx,
        `# ✅ Signal copied\n\n- Trader: **${trader.name}**\n- Trade: **${signal.direction.toUpperCase()} ${signal.symbol}**\n- Size: **${trade.lots} lots**\n- Entry: **${trade.entryPrice}**` +
        `${trade.stopLoss ? `\n- Stop loss: **${trade.stopLoss}**` : ""}${trade.takeProfit ? `\n- Take profit: **${trade.takeProfit}**` : ""}\n- Ticket: \`${trade.mt5Ticket}\``);
    } else if (trade) {
      await replyTelegram(ctx, `Copy attempt recorded but not executed.\n\nStatus: **${trade.status}**\n\nCheck the dashboard for details.`);
    } else {
      await replyTelegram(ctx, "# ❌ Signal rejected\n\nCopy rules or the risk engine rejected this signal. Open the Activity tab for the exact reason.");
    }
  });

  bot.catch((err) => logger.error({ err: String(err.error) }, "telegram bot error"));
  return bot;
}
