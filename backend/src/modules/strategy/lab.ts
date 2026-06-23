import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { audit, logError } from "../../lib/audit.js";
import { generateJson } from "../ai/service.js";
import { mt5, type Candle } from "../mt5/client.js";
import { analyzeTimeframe } from "../analysis/engine.js";
import { runBacktest, runWalkForward, type WalkForwardResult, type BacktestConfig } from "../backtest/engine.js";
import { runMonteCarlo } from "../backtest/monte-carlo.js";
import { aggregatePortfolioValidation, evaluateOosGate, splitTrainOos } from "../backtest/validation.js";
import type { BacktestStats, MonteCarloResult } from "../backtest/types.js";
import { StrategyConfigSchema, type StrategyConfig } from "./types.js";
import { latestNews } from "../news/service.js";
import { webSearch, webSearchConfigured } from "../web/search.js";
import { notify } from "../notifications/service.js";
import { recordValidationRun } from "./validation-runs.js";

/**
 * AI Strategy Lab — the AI is a hypothesis GENERATOR; the backtester is the
 * JUDGE. The model proposes strategy ideas from the current regime + news;
 * each is auto-validated with the SAME rigour we apply by hand (walk-forward
 * over 2 years with realistic per-instrument costs). Only survivors are saved
 * — always DISABLED — for the human to approve. This automates the search; it
 * does not, and cannot, manufacture an edge. Most/all proposals will fail, and
 * that is the system working correctly.
 */

// Universe restricted to instruments the backtest costs cleanly (5-digit FX +
// gold). JPY/silver are excluded — their point-size breaks the cost heuristic.
const UNIVERSE = ["EURUSD", "GBPUSD", "AUDUSD", "USDCAD", "XAUUSD"];
const TIMEFRAME_MINUTES: Record<string, number> = { M15: 15, H1: 60, H4: 240, D1: 1440 };

// Pass bar for a candidate worth human review (deliberately strict).
const PASS = { minFolds: 5, minProfitableFrac: 0.7, minTrades: 40, minMeanReturn: 0, minAvgPF: 1.1 };

const IdeaSchema = z.object({
  name: z.string().min(1).max(60),
  rationale: z.string().min(1).max(600),
  symbol: z.string(),
  style: z.enum(["confluence", "mean_reversion", "breakout"]),
  timeframe: z.enum(["M15", "H1", "H4"]).default("H1"),
  rsiOversold: z.number().min(10).max(45).optional(),
  rsiOverbought: z.number().min(55).max(90).optional(),
  regimeMaxAdx: z.number().min(10).max(40).optional(),
  stopLossAtrMult: z.number().min(0.5).max(4).optional(),
  takeProfitAtrMult: z.number().min(0.8).max(6).optional(),
});
type Idea = z.infer<typeof IdeaSchema>;
interface RecentRejectedIdea {
  name: string;
  symbol: string;
  reasons: string[];
}

export interface SensitivityResult {
  tested: number;
  robust: number;
  verdict: "robust" | "fragile";
}

export interface LabProposal {
  name: string;
  rationale: string;
  symbol: string;
  style: string;
  status: "passed" | "failed" | "invalid" | "error";
  detail: string;
  walkForward?: WalkForwardResult["consistency"];
  sensitivity?: SensitivityResult;
  oos?: {
    from: string;
    to: string;
    stats: BacktestStats;
    monteCarlo: MonteCarloResult;
    gate: ReturnType<typeof evaluateOosGate>;
  };
  portfolio?: ReturnType<typeof aggregatePortfolioValidation>;
  validationWindow?: {
    trainStart: string | null;
    trainEnd: string | null;
    oosStart: string | null;
    oosEnd: string | null;
  };
  rejectionReasons?: string[];
  savedStrategyId?: string;
}

export function strategyLabValidationVerdict(input: {
  walkForwardPassed: boolean;
  sensitivityPassed: boolean;
  oos: { passed: boolean; reasons: string[] };
  portfolio: { passed: boolean; reasons: string[] };
}) {
  const reasons: string[] = [];
  if (!input.walkForwardPassed) reasons.push("Training walk-forward gate failed");
  if (!input.sensitivityPassed) reasons.push("Parameter sensitivity gate failed");
  reasons.push(...input.oos.reasons, ...input.portfolio.reasons);
  return { passed: reasons.length === 0, reasons };
}

/**
 * Parameter-sensitivity neighbours of a config. A real edge survives small
 * parameter changes; a curve-fit one only works at the exact values it was
 * tuned to (we learned this the hard way — gold MR "worked" only at ADX=25).
 * Perturbs the exit multiples ±15% and the key entry knob by one step.
 */
export function sensitivityVariants(config: StrategyConfig): StrategyConfig[] {
  const e = config.entry;
  const x = config.exit;
  const r2 = (n: number) => Number(n.toFixed(2));
  const out: StrategyConfig[] = [];
  const add = (entryPatch: Partial<typeof e>, exitPatch: Partial<typeof x>) => {
    const parsed = StrategyConfigSchema.safeParse({ ...config, entry: { ...e, ...entryPatch }, exit: { ...x, ...exitPatch } });
    if (parsed.success) out.push(parsed.data);
  };
  add({}, { stopLossAtrMult: r2(x.stopLossAtrMult * 0.85), takeProfitAtrMult: r2(x.takeProfitAtrMult * 0.85) });
  add({}, { stopLossAtrMult: r2(x.stopLossAtrMult * 1.15), takeProfitAtrMult: r2(x.takeProfitAtrMult * 1.15) });
  if (e.style === "mean_reversion" && e.regimeMaxAdx) {
    add({ regimeMaxAdx: Math.max(10, e.regimeMaxAdx - 5) }, {});
    add({ regimeMaxAdx: Math.min(40, e.regimeMaxAdx + 5) }, {});
  } else {
    add({ rsiOversold: e.rsiOversold - 5, rsiOverbought: e.rsiOverbought + 5 }, {});
    add({ rsiOversold: e.rsiOversold + 5, rsiOverbought: e.rsiOverbought - 5 }, {});
  }
  return out;
}

export interface LabRun {
  ranAt: string;
  trigger: string;
  contextSummary: string;
  webSearchEnabled: boolean;
  proposals: LabProposal[];
  survivors: number;
}

/** Realistic spread (points) per instrument; falls back to a live tick. */
async function spreadFor(symbol: string, live?: number): Promise<number> {
  if (symbol.toUpperCase().startsWith("XAU")) return 280;
  return live && live > 0 ? live : 12;
}

async function buildContext(userId: string) {
  const regimes: { symbol: string; trend: string; adx: number | null; atrPct: number | null; spread: number }[] = [];
  for (const s of UNIVERSE) {
    try {
      const candles = await mt5.candles(s, "H1", 300);
      const a = analyzeTimeframe("H1", candles);
      const tick = await mt5.tick(s).catch(() => null);
      regimes.push({
        symbol: s, trend: a.trend,
        adx: a.adx === null ? null : Number(a.adx.toFixed(0)),
        atrPct: a.atrPct === null ? null : Number(a.atrPct.toFixed(3)),
        spread: await spreadFor(s, tick?.spread_points),
      });
    } catch {
      /* skip symbols we can't price */
    }
  }
  const calendar = (await latestNews(8).catch(() => [])).map((e) => `${e.impact} ${e.currency ?? ""} ${e.title}`);
  const headlines = (await prisma.newsEvent.findMany({
    where: { source: { startsWith: "headline:" } }, orderBy: { createdAt: "desc" }, take: 8,
  }).catch(() => [])).map((e) => e.title);
  // Latest internet resources (only if a search key is configured).
  const web = (await webSearch("forex and gold market outlook this week EURUSD GBPUSD XAUUSD sentiment", 5))
    .map((r) => `${r.title}: ${r.snippet}`);
  const recentRejected = (await prisma.validationRun.findMany({
    where: { userId, status: { in: ["FAILED", "INVALID"] } },
    orderBy: { createdAt: "desc" },
    take: 12,
  }).catch(() => [])).map((run) => ({
    name: run.candidateName,
    symbol: run.symbol,
    reasons: Array.isArray(run.rejectionReasons) ? (run.rejectionReasons as string[]).slice(0, 3) : [],
  }));
  return { regimes, calendar, headlines, web, recentRejected };
}

function buildPrompt(ctx: Awaited<ReturnType<typeof buildContext>>): string {
  return [
    "You are a quantitative strategy generator. Propose 5 DIVERSE, testable trading-strategy ideas.",
    "Each idea is a config for a backtestable engine — do NOT invent indicators outside the allowed fields.",
    "",
    "Allowed styles: 'confluence' (trend/momentum), 'mean_reversion' (fade Bollinger+RSI extremes; set regimeMaxAdx ~20-30), 'breakout' (Asian-range London break).",
    `Allowed symbols: ${UNIVERSE.join(", ")}. Allowed timeframes: M15, H1, H4.`,
    "Tune ideas to the CURRENT regime below (e.g. mean_reversion when ADX is low/ranging; trend/breakout when ADX is high).",
    "",
    "Current regime per symbol (H1): " + ctx.regimes.map((r) => `${r.symbol} trend=${r.trend} ADX=${r.adx} ATR%=${r.atrPct}`).join(" | "),
    "Upcoming calendar: " + (ctx.calendar.slice(0, 6).join("; ") || "none"),
    "Recent headlines: " + (ctx.headlines.slice(0, 6).join("; ") || "none"),
    "Latest web research: " + (ctx.web.slice(0, 5).join(" || ") || "none"),
    "Recently rejected ideas: " + (ctx.recentRejected.map((r) => `${r.name} on ${r.symbol} (${r.reasons.join("; ").slice(0, 160)})`).join(" || ") || "none"),
    "Do NOT repeat recently rejected symbol/style hypotheses unless the current regime has materially changed and your rationale states why.",
    "",
    "Respond ONLY with JSON: {\"ideas\":[{\"name\":string,\"rationale\":string,\"symbol\":string,\"style\":string,\"timeframe\":string,\"rsiOversold\":number,\"rsiOverbought\":number,\"regimeMaxAdx\":number,\"stopLossAtrMult\":number,\"takeProfitAtrMult\":number}]}",
    "rationale must reference the regime/news. Numbers optional where not relevant.",
  ].join("\n");
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function ideaStyleTokens(style: Idea["style"]): string[] {
  if (style === "mean_reversion") return ["mean", "reversion"];
  if (style === "breakout") return ["breakout"];
  return ["confluence"];
}

export function resemblesRecentRejectedIdea(idea: Idea, recentRejected: RecentRejectedIdea[]): boolean {
  const name = normalized(idea.name);
  const tokens = ideaStyleTokens(idea.style);
  return recentRejected.some((rejected) => {
    if (rejected.symbol.toUpperCase() !== idea.symbol.toUpperCase()) return false;
    const rejectedName = normalized(rejected.name);
    if (rejectedName === name) return true;
    return tokens.every((token) => name.includes(token) && rejectedName.includes(token));
  });
}

function ideaToConfig(idea: Idea): StrategyConfig | null {
  const tf = idea.timeframe;
  const timeframes = idea.style === "breakout" ? [tf] : tf === "H4" ? ["H4", "D1"] : tf === "M15" ? ["M15", "H1"] : ["H1", "H4"];
  const sessions = idea.style === "breakout"
    ? ["london", "london_newyork_overlap"]
    : ["asia", "london", "newyork", "london_newyork_overlap", "sydney"];
  const parsed = StrategyConfigSchema.safeParse({
    symbols: [idea.symbol],
    timeframes,
    entry: {
      style: idea.style,
      requireTrendAlignment: idea.style === "confluence",
      rsiOversold: idea.rsiOversold ?? 30,
      rsiOverbought: idea.rsiOverbought ?? 70,
      useMacdCross: idea.style === "confluence",
      // Candle confirmation only helps confluence; on mean-reversion it makes
      // entries so rare the sample is unusable (learned the hard way).
      useCandlePatterns: idea.style === "confluence",
      minConfidence: 0.55,
      regimeMaxAdx: idea.style === "mean_reversion" ? idea.regimeMaxAdx ?? 25 : undefined,
    },
    exit: {
      stopLossAtrMult: idea.stopLossAtrMult ?? 1.5,
      takeProfitAtrMult: idea.takeProfitAtrMult ?? 2.3,
      trailingStop: idea.style === "confluence",
    },
    lotSizing: { method: "risk_pct", fixedLots: 0.01, riskPct: 1.0 },
    maxTradesPerDay: 4,
    sessions,
    newsBehavior: "pause",
  });
  return parsed.success ? parsed.data : null;
}

function passesConsistency(c: WalkForwardResult["consistency"]): boolean {
  return (
    c.foldCount >= PASS.minFolds &&
    c.profitableFraction >= PASS.minProfitableFrac &&
    c.meanReturnPct > PASS.minMeanReturn &&
    c.totalTrades >= PASS.minTrades &&
    (c.avgProfitFactor ?? 0) >= PASS.minAvgPF
  );
}

function passes(wf: WalkForwardResult): boolean {
  return passesConsistency(wf.consistency);
}

export async function runStrategyLab(trigger: "manual" | "schedule", userId: string): Promise<LabRun> {
  const ctx = await buildContext(userId);
  const spreadOf = (s: string) => ctx.regimes.find((r) => r.symbol === s)?.spread ?? (s.startsWith("XAU") ? 280 : 12);
  const contextSummary = `${ctx.regimes.length} symbols, ${ctx.calendar.length} calendar events, ${ctx.headlines.length} headlines, ${ctx.web.length} web results`;

  // 1. Generate ideas.
  let ideas: Idea[] = [];
  try {
    const raw = (await generateJson(buildPrompt(ctx))) as { ideas?: unknown[] } | unknown[] | null;
    const list = Array.isArray(raw) ? raw : (raw?.ideas ?? []);
    for (const item of list) {
      const parsed = IdeaSchema.safeParse(item);
      if (parsed.success && UNIVERSE.includes(parsed.data.symbol.toUpperCase())) {
        ideas.push({ ...parsed.data, symbol: parsed.data.symbol.toUpperCase() });
      }
    }
  } catch (err) {
    await logError("strategy-lab", "idea generation failed", { error: String(err) });
  }
  ideas = ideas.filter((idea) => !resemblesRecentRejectedIdea(idea, ctx.recentRejected)).slice(0, 5);

  // 2. Validate each idea with a 2-year walk-forward at realistic cost.
  const candleCache = new Map<string, Candle[]>();
  const proposals: LabProposal[] = [];
  for (const idea of ideas) {
    const config = ideaToConfig(idea);
    if (!config) {
      proposals.push({
        ...ideaMeta(idea),
        status: "invalid",
        detail: "config failed schema validation",
        rejectionReasons: ["config failed schema validation"],
      });
      continue;
    }
    const tf = config.timeframes[0];
    const key = `${idea.symbol}:${tf}`;
    try {
      let candles = candleCache.get(key);
      if (!candles) {
        // ~2 years of bars, scaled to the timeframe (a flat count would request
        // years of H4/D1 and trigger a huge, timeout-prone MT5 download).
        const wanted = Math.min(Math.ceil((730 * 1440 * (5 / 7)) / (TIMEFRAME_MINUTES[tf] ?? 60)) + 250, 50000);
        candles = await mt5.candles(idea.symbol, tf, wanted);
        candleCache.set(key, candles);
      }
      if (candles.length < 600) {
        const detail = `only ${candles.length} bars — need more history`;
        proposals.push({ ...ideaMeta(idea), status: "error", detail, rejectionReasons: [detail] });
        continue;
      }
      const cfg: BacktestConfig = { initialBalance: 10000, spreadPoints: spreadOf(idea.symbol), slippagePoints: 2, commissionPerLot: 7, maxLotSize: 1 };
      const split = splitTrainOos(candles);
      if (!split.oosStart || !split.oosEnd) {
        const detail = "could not create chronological OOS window";
        proposals.push({ ...ideaMeta(idea), status: "error", detail, rejectionReasons: [detail] });
        continue;
      }
      const wf = runWalkForward({ id: "lab", name: idea.name, config: config as object }, idea.symbol, split.train, cfg, 6);
      const baseOk = passes(wf);

      // Only the base-passers earn a sensitivity sweep (cheap in practice —
      // almost nothing passes). A real edge holds under small param changes.
      let sensitivity: SensitivityResult | undefined;
      let ok = baseOk;
      if (baseOk) {
        const variants = sensitivityVariants(config);
        let robust = 0;
        for (const variant of variants) {
          const vwf = runWalkForward({ id: "lab-sens", name: "sens", config: variant as object }, idea.symbol, split.train, cfg, 6);
          if (vwf.consistency.meanReturnPct > 0 && vwf.consistency.profitableFraction >= 0.5) robust++;
        }
        sensitivity = { tested: variants.length, robust, verdict: variants.length > 0 && robust / variants.length >= 0.6 ? "robust" : "fragile" };
        ok = sensitivity.verdict === "robust";
      }

      const oosResult = runBacktest(
        { id: "lab-oos", name: idea.name, config: config as object },
        idea.symbol,
        candles,
        cfg,
        {
          tradeStartMs: Date.parse(split.oosStart),
          tradeEndMs: Date.parse(split.oosEnd) + (TIMEFRAME_MINUTES[tf] ?? 60) * 60_000,
        },
      );
      const oosMonteCarlo = runMonteCarlo(oosResult.trades, cfg.initialBalance, { iterations: 2000, seed: 20260615 });
      const oosGate = evaluateOosGate({
        trades: oosResult.stats.trades,
        returnPct: oosResult.stats.returnPct,
        profitFactor: oosResult.stats.profitFactor,
        maxDrawdownPct: oosResult.stats.maxDrawdownPct,
        monteCarloReturnP05: oosMonteCarlo.returnPct.p05,
      });

      const portfolioResults = [];
      if (baseOk && sensitivity?.verdict === "robust" && oosGate.passed) {
        for (const symbol of UNIVERSE) {
          const basketKey = `${symbol}:${tf}`;
          let basketCandles = candleCache.get(basketKey);
          if (!basketCandles) {
            const wanted = Math.min(Math.ceil((730 * 1440 * (5 / 7)) / (TIMEFRAME_MINUTES[tf] ?? 60)) + 250, 50000);
            basketCandles = await mt5.candles(symbol, tf, wanted);
            candleCache.set(basketKey, basketCandles);
          }
          if (basketCandles.length < 600) {
            portfolioResults.push({ symbol, trades: 0, returnPct: 0, maxDrawdownPct: 0, passed: false });
            continue;
          }
          const basketSplit = splitTrainOos(basketCandles);
          if (!basketSplit.oosStart || !basketSplit.oosEnd) {
            portfolioResults.push({ symbol, trades: 0, returnPct: 0, maxDrawdownPct: 0, passed: false });
            continue;
          }
          const basketConfig = { ...config, symbols: [symbol] };
          const basketCfg = { ...cfg, spreadPoints: spreadOf(symbol) };
          const result = runBacktest(
            { id: "lab-portfolio", name: idea.name, config: basketConfig as object },
            symbol,
            basketCandles,
            basketCfg,
            {
              tradeStartMs: Date.parse(basketSplit.oosStart),
              tradeEndMs: Date.parse(basketSplit.oosEnd) + (TIMEFRAME_MINUTES[tf] ?? 60) * 60_000,
            },
          );
          const monteCarlo = runMonteCarlo(result.trades, basketCfg.initialBalance, { iterations: 1000, seed: 20260615 });
          const gate = evaluateOosGate({
            trades: result.stats.trades,
            returnPct: result.stats.returnPct,
            profitFactor: result.stats.profitFactor,
            maxDrawdownPct: result.stats.maxDrawdownPct,
            monteCarloReturnP05: monteCarlo.returnPct.p05,
          });
          portfolioResults.push({
            symbol,
            trades: result.stats.trades,
            returnPct: result.stats.returnPct,
            maxDrawdownPct: result.stats.maxDrawdownPct,
            passed: gate.passed,
          });
        }
      }
      const portfolio = aggregatePortfolioValidation(portfolioResults);
      const verdict = strategyLabValidationVerdict({
        walkForwardPassed: baseOk,
        sensitivityPassed: !baseOk || sensitivity?.verdict === "robust",
        oos: oosGate,
        portfolio: baseOk && sensitivity?.verdict === "robust" && oosGate.passed
          ? portfolio
          : { passed: true, reasons: [] },
      });
      ok = verdict.passed;

      let savedStrategyId: string | undefined;
      if (ok) {
        const saved = await prisma.strategy.create({
          data: { userId, name: `AI Candidate: ${idea.name}`.slice(0, 80), type: idea.style, enabled: false, config: config as object },
        });
        savedStrategyId = saved.id;
      }
      proposals.push({
        ...ideaMeta(idea), status: ok ? "passed" : "failed",
        detail: ok ? "Passed training walk-forward, sensitivity, held-out OOS, Monte Carlo, and portfolio gates."
          : verdict.reasons.join("; "),
        walkForward: wf.consistency,
        sensitivity,
        oos: { from: split.oosStart, to: split.oosEnd, stats: oosResult.stats, monteCarlo: oosMonteCarlo, gate: oosGate },
        portfolio: portfolioResults.length ? portfolio : undefined,
        validationWindow: {
          trainStart: split.trainStart,
          trainEnd: split.trainEnd,
          oosStart: split.oosStart,
          oosEnd: split.oosEnd,
        },
        rejectionReasons: verdict.reasons,
        savedStrategyId,
      });
    } catch (err) {
      const detail = `validation error: ${String(err).slice(0, 120)}`;
      proposals.push({ ...ideaMeta(idea), status: "error", detail, rejectionReasons: [detail] });
    }
  }

  const survivors = proposals.filter((p) => p.status === "passed").length;
  const run: LabRun = { ranAt: new Date().toISOString(), trigger, contextSummary, webSearchEnabled: webSearchConfigured(), proposals, survivors };
  for (const proposal of proposals) {
    await recordValidationRun({
      userId,
      strategyId: proposal.savedStrategyId,
      candidateName: proposal.name,
      symbol: proposal.symbol,
      status: proposal.status.toUpperCase() as "PASSED" | "FAILED" | "INVALID" | "ERROR",
      trigger,
      trainStart: proposal.validationWindow?.trainStart,
      trainEnd: proposal.validationWindow?.trainEnd,
      oosStart: proposal.validationWindow?.oosStart,
      oosEnd: proposal.validationWindow?.oosEnd,
      instruments: proposal.portfolio?.results.map((result) => result.symbol) ?? [proposal.symbol],
      metrics: {
        walkForward: proposal.walkForward ?? null,
        sensitivity: proposal.sensitivity ?? null,
        oos: proposal.oos ? { stats: proposal.oos.stats, monteCarlo: proposal.oos.monteCarlo } : null,
        portfolio: proposal.portfolio ?? null,
      },
      gates: {
        walkForward: proposal.walkForward ? passesConsistency(proposal.walkForward) : false,
        sensitivity: proposal.sensitivity?.verdict === "robust",
        oos: proposal.oos?.gate.passed ?? false,
        portfolio: proposal.portfolio?.passed ?? false,
      },
      rejectionReasons: proposal.rejectionReasons ?? (proposal.status === "passed" ? [] : [proposal.detail]),
    });
  }
  await prisma.systemSetting.upsert({
    where: { key: "strategy_lab:last" },
    create: { key: "strategy_lab:last", value: run as object },
    update: { value: run as object },
  });
  await audit({ actor: `strategy-lab:${trigger}`, userId, category: "strategy", action: "strategy_lab_run", detail: { ideas: ideas.length, survivors } });
  if (survivors > 0) {
    await notify(userId, "approval_request", `Strategy Lab: ${survivors} candidate(s) passed validation`,
      `The AI proposed ${proposals.length} strategies; ${survivors} survived 2-year walk-forward. Review them in Strategy Lab — they are saved DISABLED until you approve.`);
  }
  return run;
}

function ideaMeta(idea: Idea) {
  return { name: idea.name, rationale: idea.rationale, symbol: idea.symbol, style: idea.style };
}

export async function lastLabRun(): Promise<LabRun | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: "strategy_lab:last" } });
  return (row?.value as LabRun | undefined) ?? null;
}
