/**
 * Pipeline trace: runs every stage of the trade pipeline against the live
 * bridge and prints what each stage decides. Read-only — never places trades.
 *
 *   npx tsx scripts/trace-pipeline.ts [SYMBOL]
 */
import { prisma } from "../src/lib/prisma.js";
import { mt5 } from "../src/modules/mt5/client.js";
import { buildMarketAnalysis } from "../src/modules/analysis/engine.js";
import { evaluateStrategy, deriveLevels } from "../src/modules/strategy/service.js";
import { assessNewsRisk } from "../src/modules/news/service.js";
import { askModel } from "../src/modules/ai/service.js";
import { buildTradePrompt } from "../src/modules/ai/prompts.js";
import { validateTrade } from "../src/modules/risk/engine.js";
import { buildRiskContext, sessionNow } from "../src/modules/trading/service.js";
import { getBotState } from "../src/modules/system/state.js";

const symbol = process.argv[2] ?? "EURUSD";

const user = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
const strategy = await prisma.strategy.findFirstOrThrow();
const settings = await prisma.riskSettings.findUniqueOrThrow({ where: { userId: user.id } });
const state = await getBotState();

console.log(`\n=== PIPELINE TRACE: ${symbol} | strategy "${strategy.name}" (enabled=${strategy.enabled}) | bot=${state.status}/${state.mode} ===\n`);

// 1. Market data
const tick = await mt5.tick(symbol);
console.log(`[1] MARKET DATA   bid=${tick.bid} ask=${tick.ask} spread=${tick.spread_points}pts`);
const cfg = strategy.config as { timeframes?: string[] };
const candlesByTf: Record<string, Awaited<ReturnType<typeof mt5.candles>>> = {};
for (const tf of cfg.timeframes ?? ["M15", "H1"]) {
  candlesByTf[tf] = await mt5.candles(symbol, tf, 200);
  console.log(`    ${tf}: ${candlesByTf[tf].length} candles, last close ${candlesByTf[tf].at(-1)?.close}`);
}

// 2. Technical analysis
const analysis = buildMarketAnalysis(symbol, tick, candlesByTf);
console.log(`\n[2] ANALYSIS      session=${analysis.session}`);
for (const tf of analysis.timeframes) {
  console.log(`    ${tf.timeframe}: trend=${tf.trend} structure=${tf.structure} rsi=${tf.rsi?.toFixed(1)} macdH=${tf.macdHistogram?.toFixed(5)} atr%=${tf.atrPct?.toFixed(2)} pattern=${tf.candlePattern ?? "none"}`);
}

// 3. Strategy signal
const signal = evaluateStrategy(strategy, analysis);
console.log(`\n[3] STRATEGY      signal=${signal.direction ?? "NO SIGNAL"}`);
for (const r of signal.reasons) console.log(`    - ${r}`);

// 4. News gate
const news = await assessNewsRisk(symbol, settings);
console.log(`\n[4] NEWS GATE     level=${news.level} action=${news.action}`);
console.log(`    ${news.reason}`);

// 5. AI reasoning (runs even without a signal, for the trace)
const levels = signal.direction ? deriveLevels(signal, analysis) : null;
const prompt = buildTradePrompt(
  analysis, news,
  `${signal.strategyName}: signal=${signal.direction ?? "none"}; reasons: ${signal.reasons.join("; ")}`,
  `maxRiskPerTrade=${settings.maxRiskPerTradePct}%, minRR=${settings.minRiskReward}`,
);
const { decision: ai } = await askModel(prompt, symbol);
console.log(`\n[5] AI (gemma)    decision=${ai.decision} confidence=${ai.confidence} risk=${ai.risk_level}`);
console.log(`    ${ai.reasoning.slice(0, 400)}`);

// 6. Risk engine (uses signal levels if present, else a synthetic sane proposal)
const entry = tick.ask;
const proposal = {
  symbol,
  direction: (signal.direction ?? "buy") as "buy" | "sell",
  lots: 0.1,
  entry,
  stopLoss: levels?.stopLoss ?? entry * 0.997,
  takeProfit: levels?.takeProfit ?? entry * 1.006,
};
const primaryAtrPct = analysis.timeframes[0]?.atrPct ?? null;
const ctx = await buildRiskContext(user, settings, await mt5.accountInfo(), tick.spread_points, primaryAtrPct, sessionNow(), news.action);
const risk = validateTrade(proposal, ctx);
console.log(`\n[6] RISK ENGINE   ${risk.ok ? "ALL CHECKS PASSED" : "BLOCKED"} (proposal: ${proposal.direction} ${proposal.lots} @ ${entry}, SL ${proposal.stopLoss.toFixed(5)}, TP ${proposal.takeProfit.toFixed(5)})`);
for (const c of risk.checks) console.log(`    ${c.passed ? "✓" : "✗"} ${c.name}: ${c.detail}`);

// 7. Verdict
console.log(`\n[7] VERDICT`);
if (!strategy.enabled) console.log(`    ✗ Strategy is DISABLED — the scheduler will never evaluate it. Enable it in the dashboard.`);
if (state.status !== "running") console.log(`    ✗ Bot is ${state.status} — no new trades while not running.`);
const aiAgrees = signal.direction && ai.decision === signal.direction;
console.log(`    Signal: ${signal.direction ?? "none"} | AI agrees: ${aiAgrees ? "yes" : "no"} | News: ${news.action} | Risk: ${risk.ok ? "pass" : "fail"}`);
if (signal.direction && aiAgrees && risk.ok && news.action !== "pause") {
  console.log(`    → In ${state.mode} mode this WOULD ${state.mode === "AUTO" ? "EXECUTE" : "create an APPROVAL REQUEST"}.`);
} else {
  console.log(`    → No trade right now — that is the pipeline working, not failing. It trades when conditions align.`);
}

await prisma.$disconnect();
process.exit(0);
