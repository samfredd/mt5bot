import type { Candle } from "../mt5/client.js";
import type { NewsRiskAssessment } from "../news/service.js";
import { computeTimeframeFeatures, type TimeframeFeatures } from "./features.js";

/**
 * Decision-context builder: converts raw market data + deterministic feature
 * reads into the compact, high-signal JSON payload the LLM judges. The model
 * never sees raw candles or unrounded indicator dumps — only interpreted
 * evidence, a deterministic confidence score, and an explicit list of what is
 * MISSING so it can refuse instead of inventing.
 *
 * Everything here is pure; call sites supply market data, news, sentiment and
 * the proposed setup.
 */

// ---------- payload types (what the LLM actually receives) ----------

export interface TimeframeSummary {
  timeframe: string;
  trend: string; // "BULLISH (72, ACCELERATING)"
  structure: {
    status: string;
    bos: boolean;
    choch: boolean;
    last_swing_high: number | null;
    last_swing_low: number | null;
  };
  momentum: { score: number | null; rsi: string | null; macd: string | null; divergence: string };
  volume: { score: number | null; relative: number | null; trend: string | null; spike: boolean; bias: string | null } | null;
  volatility: { regime: string | null; atr: number | null; atr_percentile: number | null; expected_move_pct: number | null };
  key_support: number[];
  key_resistance: number[];
  liquidity: string[];
  demand_zones: number[][];
  supply_zones: number[][];
}

export interface MtfAlignment {
  frames: Record<string, string>;
  bull_score: number;
  bear_score: number;
  neutral_score: number;
  alignment_confidence: number;
}

export interface SentimentContext {
  /** -100 (max bearish) .. +100 (max bullish). */
  score: number;
  label: string;
  confidence: number;
  age_minutes: number;
  summary: string;
}

export interface NewsContext {
  risk: string;
  action: string;
  reason: string;
  next_high_impact_in_min: number | null;
  next_high_impact_title: string | null;
}

export interface SetupContext {
  source: string;
  proposed_direction: string;
  signal_reasons: string[];
  entry: number;
  stop_loss: number;
  take_profit: number;
  risk_reward: number | null;
  stop_distance_pct: number | null;
  stop_distance_atr: number | null;
  stop_quality: string;
  tp_quality: string;
  /** Driftless random-walk estimate: slDist vs tpDist race. */
  est_stop_hit_probability: number | null;
  suggested_lots: number | null;
  money_at_risk: number | null;
  risk_pct_of_balance: number | null;
}

export interface ConfidenceEngineOutput {
  overall_confidence: number;
  trade_quality: "A+" | "A" | "B" | "C" | "D";
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  edge_strength: number;
  components: Record<string, number | null>;
  conflicts: string[];
}

export interface DecisionContext {
  symbol: string;
  generated_at: string;
  session: string;
  quote: { bid: number; ask: number; spread_points: number };
  market_regime: string;
  mtf: MtfAlignment;
  timeframes: TimeframeSummary[];
  sentiment: SentimentContext | null;
  news: NewsContext;
  setup: SetupContext;
  account: { balance: number; equity: number; currency: string; open_positions: number } | null;
  limits: Record<string, number> | null;
  confidence_engine: ConfidenceEngineOutput;
  missing_data: string[];
}

// ---------- inputs ----------

export interface SentimentInput {
  /** -1..1 as produced by the sentiment service. */
  score: number;
  label: string;
  confidence: number;
  ageSeconds: number;
  summary: string;
}

export interface SetupInput {
  source: string;
  direction: "buy" | "sell";
  signalReasons: string[];
  entry: number;
  stopLoss: number;
  takeProfit: number;
  suggestedLots?: number | null;
  moneyAtRisk?: number | null;
  riskPctOfBalance?: number | null;
}

export interface DecisionContextInput {
  symbol: string;
  session: string;
  quote: { bid: number; ask: number; spreadPoints: number };
  /** Ordered lowest → highest timeframe (e.g. { M15, H1, H4 }). */
  candlesByTf: Record<string, Candle[]>;
  news: NewsRiskAssessment;
  sentiment: SentimentInput | null;
  setup: SetupInput;
  account?: { balance: number; equity: number; currency: string; openPositions: number } | null;
  limits?: Record<string, number> | null;
  now?: Date;
}

// ---------- helpers ----------

/** Round to ~6 significant digits so payload numbers stay short and honest. */
export function compactNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toPrecision(6));
}

const round2 = (v: number) => Number(v.toFixed(2));

// ---------- multi-timeframe alignment ----------

export function mtfAlignment(features: TimeframeFeatures[]): MtfAlignment {
  const frames: Record<string, string> = {};
  let bull = 0;
  let bear = 0;
  let neutral = 0;
  let total = 0;
  features.forEach((f, idx) => {
    const weight = idx + 1; // higher timeframes (later entries) weigh more
    total += weight;
    const dir = f.trend.direction;
    frames[f.timeframe] = dir + (f.trend.strength !== null ? ` (${f.trend.strength})` : "");
    if (dir === "BULLISH") bull += weight;
    else if (dir === "BEARISH") bear += weight;
    else neutral += weight;
  });
  if (total === 0) return { frames, bull_score: 0, bear_score: 0, neutral_score: 100, alignment_confidence: 0 };
  const bullScore = Math.round((bull / total) * 100);
  const bearScore = Math.round((bear / total) * 100);
  return {
    frames,
    bull_score: bullScore,
    bear_score: bearScore,
    neutral_score: Math.max(0, 100 - bullScore - bearScore),
    alignment_confidence: Math.min(100, Math.abs(bullScore - bearScore)),
  };
}

export function classifyRegime(mtf: MtfAlignment, primaryVolRegime: string | null): string {
  if (primaryVolRegime === "EXTREME" && mtf.alignment_confidence < 50) return "VOLATILE_RANGE";
  if (mtf.alignment_confidence >= 50) return mtf.bull_score > mtf.bear_score ? "TRENDING_BULLISH" : "TRENDING_BEARISH";
  return "RANGING";
}

// ---------- setup / risk metrics ----------

export function stopHitProbability(entry: number, stopLoss: number, takeProfit: number): number | null {
  const slDist = Math.abs(entry - stopLoss);
  const tpDist = Math.abs(takeProfit - entry);
  if (slDist <= 0 || tpDist <= 0) return null;
  // Gambler's-ruin for a driftless walk: nearer barrier gets hit more often.
  return round2(tpDist / (slDist + tpDist));
}

export function buildSetupContext(input: SetupInput, primary: TimeframeFeatures | null): SetupContext {
  const { entry, stopLoss, takeProfit, direction } = input;
  const slDist = Math.abs(entry - stopLoss);
  const tpDist = Math.abs(takeProfit - entry);
  const rr = slDist > 0 ? round2(tpDist / slDist) : null;
  const atr = primary?.volatility.atr ?? null;
  const stopAtr = atr && atr > 0 ? round2(slDist / atr) : null;

  let stopQuality = "unassessed (no structure data)";
  if (primary) {
    const swing = direction === "buy" ? primary.structure.lastSwingLow : primary.structure.lastSwingHigh;
    const beyondSwing = swing !== null && (direction === "buy" ? stopLoss < swing : stopLoss > swing);
    const width = stopAtr === null ? "" : stopAtr < 0.8 ? "; tight (<0.8 ATR)" : stopAtr > 2.5 ? "; wide (>2.5 ATR)" : "";
    stopQuality = beyondSwing
      ? `beyond the last swing ${direction === "buy" ? "low" : "high"} — structure-protected${width}`
      : `inside recent structure — exposed to ordinary rotation${width}`;
  }

  let tpQuality = "unassessed (no level data)";
  if (primary) {
    const opposing = direction === "buy" ? primary.resistance : primary.support;
    const blocker = opposing.find((l) => (direction === "buy" ? l.price < takeProfit && l.price > entry : l.price > takeProfit && l.price < entry));
    tpQuality = blocker
      ? `${direction === "buy" ? "resistance" : "support"} at ${compactNumber(blocker.price)} (${blocker.touches} touches) sits before the target`
      : "no mapped opposing level before the target";
  }

  return {
    source: input.source,
    proposed_direction: direction.toUpperCase(),
    signal_reasons: input.signalReasons.slice(0, 8).map((r) => r.slice(0, 120)),
    entry: compactNumber(entry),
    stop_loss: compactNumber(stopLoss),
    take_profit: compactNumber(takeProfit),
    risk_reward: rr,
    stop_distance_pct: entry > 0 ? round2((slDist / entry) * 100) : null,
    stop_distance_atr: stopAtr,
    stop_quality: stopQuality,
    tp_quality: tpQuality,
    est_stop_hit_probability: stopHitProbability(entry, stopLoss, takeProfit),
    suggested_lots: input.suggestedLots ?? null,
    money_at_risk: input.moneyAtRisk != null ? round2(input.moneyAtRisk) : null,
    risk_pct_of_balance: input.riskPctOfBalance ?? null,
  };
}

// ---------- confidence engine ----------

export interface ConfidenceInputs {
  direction: "buy" | "sell";
  primary: TimeframeFeatures | null;
  higher: TimeframeFeatures | null;
  mtf: MtfAlignment;
  sentiment: SentimentInput | null;
  news: NewsRiskAssessment;
  setup: SetupContext;
  minRiskReward?: number | null;
}

const WEIGHTS: Record<string, number> = {
  trend: 0.2,
  structure: 0.2,
  momentum: 0.15,
  volume: 0.1,
  volatility: 0.1,
  sentiment: 0.1,
  risk: 0.15,
};

function clamp100(v: number): number {
  return Math.round(Math.max(0, Math.min(100, v)));
}

export function runConfidenceEngine(inputs: ConfidenceInputs): ConfidenceEngineOutput {
  const { direction, primary, higher, mtf, sentiment, news, setup } = inputs;
  const sign = direction === "buy" ? 1 : -1;
  const conflicts: string[] = [];
  const components: Record<string, number | null> = {
    trend: null, structure: null, momentum: null, volume: null, volatility: null, sentiment: null, risk: null,
  };

  // Trend: strength when aligned with the proposal, inverted when opposed.
  if (primary && primary.trend.strength !== null) {
    const dir = primary.trend.direction;
    if (dir === "RANGING") components.trend = 40;
    else if ((dir === "BULLISH") === (direction === "buy")) components.trend = primary.trend.strength;
    else {
      components.trend = clamp100(60 - primary.trend.strength);
      conflicts.push(`${primary.timeframe} trend is ${dir} against the proposed ${direction.toUpperCase()}`);
    }
  }
  if (higher && higher.trend.direction !== "RANGING" && (higher.trend.direction === "BULLISH") !== (direction === "buy")) {
    conflicts.push(`${higher.timeframe} trend is ${higher.trend.direction} against the proposed ${direction.toUpperCase()}`);
  }

  // Structure: status/BOS with the trade help, CHOCH against it hurts badly.
  if (primary) {
    let s = 50;
    const st = primary.structure;
    if ((st.status === "BULLISH") === (direction === "buy") && st.status !== "NEUTRAL") s += 20;
    if (st.status !== "NEUTRAL" && (st.status === "BULLISH") !== (direction === "buy")) {
      s -= 20;
      conflicts.push(`market structure is ${st.status} against the trade`);
    }
    if (st.bos && (st.status === "BULLISH") === (direction === "buy")) s += 15;
    if (st.choch) {
      s -= 25;
      conflicts.push("recent change of character (CHOCH) — prior structure broken");
    }
    components.structure = clamp100(s);
  }

  // Momentum: score is bullish-oriented; mirror for sells.
  if (primary && primary.momentum.score !== null) {
    const raw = direction === "buy" ? primary.momentum.score : 100 - primary.momentum.score;
    let m = raw;
    const div = primary.momentum.divergence;
    if ((div === "BEARISH" && direction === "buy") || (div === "BULLISH" && direction === "sell")) {
      m -= 15;
      conflicts.push(`${div.toLowerCase()} divergence against the trade`);
    }
    components.momentum = clamp100(m);
  }

  // Volume: confirmation-quality, direction-agnostic.
  if (primary && primary.volume.score !== null) {
    let v = primary.volume.score;
    if (primary.volume.trend === "FALLING") v -= 10;
    if (
      (primary.volume.bias === "DISTRIBUTION" && direction === "buy") ||
      (primary.volume.bias === "ACCUMULATION" && direction === "sell")
    ) {
      v -= 10;
      conflicts.push(`volume bias reads ${primary.volume.bias} against the trade`);
    }
    components.volume = clamp100(v);
  }

  // Volatility: NORMAL is tradeable; EXTREME is hostile.
  if (primary && primary.volatility.regime !== null) {
    components.volatility =
      primary.volatility.regime === "NORMAL" ? 70 : primary.volatility.regime === "LOW" ? 55 : primary.volatility.regime === "HIGH" ? 45 : 20;
  }

  // Sentiment: -1..1 score scaled by its own confidence, oriented to direction.
  if (sentiment !== null) {
    components.sentiment = clamp100(50 + sign * sentiment.score * sentiment.confidence * 50);
    if (sign * sentiment.score < -0.3 && sentiment.confidence >= 0.5) {
      conflicts.push(`sentiment (${sentiment.label}) leans against the trade`);
    }
  }

  // Risk: R:R plus stop quality plus stop-hit odds.
  {
    let r: number | null = null;
    if (setup.risk_reward !== null) {
      r = setup.risk_reward >= 3 ? 85 : setup.risk_reward >= 2 ? 70 : setup.risk_reward >= 1.5 ? 55 : 30;
      if (inputs.minRiskReward != null && setup.risk_reward < inputs.minRiskReward) {
        r = Math.min(r, 25);
        conflicts.push(`R:R ${setup.risk_reward} is below the configured minimum ${inputs.minRiskReward}`);
      }
      if (setup.stop_quality.startsWith("beyond")) r += 10;
      if (setup.est_stop_hit_probability !== null && setup.est_stop_hit_probability > 0.55) r -= 15;
      r = clamp100(r);
    }
    components.risk = r;
  }

  if (news.level === "high") conflicts.push("high-impact news risk in the trading window");

  // Weighted blend over PRESENT components (missing data must not inflate).
  let weighted = 0;
  let weightSum = 0;
  let missing = 0;
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    const value = components[name];
    if (value === null || value === undefined) { missing++; continue; }
    weighted += value * weight;
    weightSum += weight;
  }
  let overall = weightSum > 0 ? weighted / weightSum : 0;
  overall -= Math.min(3, conflicts.length) * 6; // conflicting evidence is a real cost
  if (missing >= 2) overall = Math.min(overall, 75); // thin evidence caps conviction
  const overallRounded = clamp100(overall);

  const quality: ConfidenceEngineOutput["trade_quality"] =
    overallRounded >= 85 ? "A+" : overallRounded >= 75 ? "A" : overallRounded >= 65 ? "B" : overallRounded >= 50 ? "C" : "D";

  const volRegime = primary?.volatility.regime ?? null;
  const pStop = setup.est_stop_hit_probability;
  const riskLevel: ConfidenceEngineOutput["risk_level"] =
    volRegime === "EXTREME" || news.level === "high" || (pStop !== null && pStop > 0.6) || overallRounded < 50
      ? "HIGH"
      : overallRounded >= 75 && news.level === "low" && (volRegime === "LOW" || volRegime === "NORMAL") && (pStop === null || pStop <= 0.5)
        ? "LOW"
        : "MEDIUM";

  return {
    overall_confidence: overallRounded,
    trade_quality: quality,
    risk_level: riskLevel,
    edge_strength: clamp100((overallRounded - 50) * 2),
    components,
    conflicts,
  };
}

// ---------- news / sentiment shaping ----------

export function buildNewsContext(news: NewsRiskAssessment, now: Date): NewsContext {
  let nextMin: number | null = null;
  let nextTitle: string | null = null;
  for (const event of news.upcomingEvents) {
    const t = Date.parse(event.eventTime);
    if (Number.isNaN(t) || t < now.getTime()) continue;
    const minutes = Math.round((t - now.getTime()) / 60_000);
    if (nextMin === null || minutes < nextMin) {
      nextMin = minutes;
      nextTitle = `${event.title} (${event.impact})`;
    }
  }
  return {
    risk: news.level.toUpperCase(),
    action: news.action,
    reason: news.reason.slice(0, 200),
    next_high_impact_in_min: nextMin,
    next_high_impact_title: nextTitle,
  };
}

export function buildSentimentContext(sentiment: SentimentInput | null): SentimentContext | null {
  if (!sentiment || sentiment.confidence <= 0) return null;
  return {
    score: Math.round(sentiment.score * 100),
    label: sentiment.label,
    confidence: Math.round(sentiment.confidence * 100),
    age_minutes: Math.round(sentiment.ageSeconds / 60),
    summary: sentiment.summary.slice(0, 160),
  };
}

// ---------- timeframe summarization ----------

function summarizeTimeframe(f: TimeframeFeatures): TimeframeSummary {
  const trendLabel =
    f.trend.direction +
    (f.trend.strength !== null ? ` (strength ${f.trend.strength}${f.trend.acceleration ? `, ${f.trend.acceleration}` : ""})` : "");
  return {
    timeframe: f.timeframe,
    trend: trendLabel,
    structure: {
      status: f.structure.status,
      bos: f.structure.bos,
      choch: f.structure.choch,
      last_swing_high: f.structure.lastSwingHigh !== null ? compactNumber(f.structure.lastSwingHigh) : null,
      last_swing_low: f.structure.lastSwingLow !== null ? compactNumber(f.structure.lastSwingLow) : null,
    },
    momentum: {
      score: f.momentum.score,
      rsi: f.momentum.rsiNote,
      macd: f.momentum.macdNote,
      divergence: f.momentum.divergence,
    },
    volume:
      f.volume.score === null
        ? null
        : { score: f.volume.score, relative: f.volume.relative, trend: f.volume.trend, spike: f.volume.spike, bias: f.volume.bias },
    volatility: {
      regime: f.volatility.regime,
      atr: f.volatility.atr !== null ? compactNumber(f.volatility.atr) : null,
      atr_percentile: f.volatility.percentile,
      expected_move_pct: f.volatility.expectedMovePct,
    },
    key_support: f.support.map((l) => compactNumber(l.price)),
    key_resistance: f.resistance.map((l) => compactNumber(l.price)),
    liquidity: f.liquidity.map((p) => `${p.side === "above" ? "equal highs" : "equal lows"}@${compactNumber(p.price)} (${p.touches}x)`),
    demand_zones: f.demandZones.map((z) => [compactNumber(z.low), compactNumber(z.high)]),
    supply_zones: f.supplyZones.map((z) => [compactNumber(z.low), compactNumber(z.high)]),
  };
}

// ---------- top-level builder ----------

export function buildDecisionContext(input: DecisionContextInput): DecisionContext {
  const now = input.now ?? new Date();
  const entries = Object.entries(input.candlesByTf);
  const features = entries.map(([tf, candles]) => computeTimeframeFeatures(tf, candles));
  const primary = features[0] ?? null;
  const higher = features.length > 1 ? features[features.length - 1] : null;

  const mtf = mtfAlignment(features);
  const setup = buildSetupContext(input.setup, primary);
  const sentiment = buildSentimentContext(input.sentiment);
  const news = buildNewsContext(input.news, now);
  const confidence = runConfidenceEngine({
    direction: input.setup.direction,
    primary,
    higher,
    mtf,
    sentiment: input.sentiment,
    news: input.news,
    setup,
    minRiskReward: input.limits?.min_rr ?? null,
  });

  const missing: string[] = [];
  if (!sentiment) missing.push("sentiment (no fresh reading — do not assume market mood)");
  if (primary?.volume.score == null) missing.push("volume analysis (tick volume unavailable)");
  if (primary?.volatility.percentile == null) missing.push("atr_percentile (insufficient history)");
  if (primary?.trend.strength == null) missing.push("trend strength (insufficient history)");
  if (primary && primary.structure.status === "NEUTRAL" && primary.structure.lastSwingHigh === null) {
    missing.push("market structure (too few swings)");
  }

  return {
    symbol: input.symbol.toUpperCase(),
    generated_at: now.toISOString(),
    session: input.session,
    quote: {
      bid: compactNumber(input.quote.bid),
      ask: compactNumber(input.quote.ask),
      spread_points: input.quote.spreadPoints,
    },
    market_regime: classifyRegime(mtf, primary?.volatility.regime ?? null),
    mtf,
    timeframes: features.map(summarizeTimeframe),
    sentiment,
    news,
    setup,
    account: input.account
      ? {
          balance: round2(input.account.balance),
          equity: round2(input.account.equity),
          currency: input.account.currency,
          open_positions: input.account.openPositions,
        }
      : null,
    limits: input.limits ?? null,
    confidence_engine: confidence,
    missing_data: missing,
  };
}

/** Render for the prompt: nulls stripped (missing_data carries the absences). */
export function renderDecisionContext(context: DecisionContext): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === null || v === undefined) continue;
        out[k] = strip(v);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(strip(context), null, 1);
}

// ---------- scalping variant (compact, latency-critical) ----------

export interface ScalpFeasibility {
  lots: number;
  target_money: number;
  max_loss_money: number;
  spread_cost_money: number | null;
  target_distance_points: number | null;
  m1_atr_points: number | null;
  /** How many 1-minute ATRs the price must travel to pay the target. */
  target_in_m1_atrs: number | null;
}

export interface ScalpDecisionContext {
  symbol: string;
  session: string;
  proposed_direction: string;
  quote: { bid: number; ask: number; spread_points: number };
  m1: TimeframeSummary;
  m5: TimeframeSummary;
  feasibility: ScalpFeasibility | null;
  confidence_engine: ConfidenceEngineOutput;
  missing_data: string[];
}

export function buildScalpContext(input: {
  symbol: string;
  session: string;
  direction: "buy" | "sell";
  quote: { bid: number; ask: number; spreadPoints: number };
  candlesByTf: Record<string, Candle[]>;
  news: NewsRiskAssessment;
  feasibility: ScalpFeasibility | null;
}): ScalpDecisionContext {
  const entries = Object.entries(input.candlesByTf);
  const features = entries.map(([tf, candles]) => computeTimeframeFeatures(tf, candles));
  const m1 = features[0];
  const m5 = features[features.length - 1];
  const entry = input.direction === "buy" ? input.quote.ask : input.quote.bid;
  const atr = m1?.volatility.atr ?? 0;
  // Synthetic micro-levels for the confidence engine: exits are money-based,
  // so score risk on a 1-ATR stop vs the money-target distance (in M1 ATRs).
  const targetAtrs = input.feasibility?.target_in_m1_atrs;
  const targetDist = targetAtrs != null && targetAtrs > 0 ? Math.max(atr * targetAtrs, atr * 0.05) : atr;
  const syntheticSetup = buildSetupContext(
    {
      source: "scalper",
      direction: input.direction,
      signalReasons: [],
      entry,
      stopLoss: input.direction === "buy" ? entry - atr : entry + atr,
      takeProfit: input.direction === "buy" ? entry + targetDist : entry - targetDist,
    },
    m1 ?? null,
  );
  const confidence = runConfidenceEngine({
    direction: input.direction,
    primary: m1 ?? null,
    higher: m5 ?? null,
    mtf: mtfAlignment(features),
    sentiment: null,
    news: input.news,
    setup: syntheticSetup,
  });
  const missing: string[] = [];
  if (!input.feasibility) missing.push("target feasibility (instrument spec unavailable)");
  if (m1?.volume.score == null) missing.push("volume analysis");
  if (m1?.volatility.percentile == null) missing.push("atr_percentile");

  return {
    symbol: input.symbol.toUpperCase(),
    session: input.session,
    proposed_direction: input.direction.toUpperCase(),
    quote: { bid: compactNumber(input.quote.bid), ask: compactNumber(input.quote.ask), spread_points: input.quote.spreadPoints },
    m1: summarizeTimeframe(m1 ?? computeTimeframeFeatures("M1", [])),
    m5: summarizeTimeframe(m5 ?? computeTimeframeFeatures("M5", [])),
    feasibility: input.feasibility,
    confidence_engine: confidence,
    missing_data: missing,
  };
}

export function renderScalpContext(context: ScalpDecisionContext): string {
  return renderDecisionContext(context as unknown as DecisionContext);
}
