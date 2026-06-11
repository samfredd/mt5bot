import type { MarketAnalysis } from "../analysis/engine.js";
import type { NewsRiskAssessment } from "../news/service.js";

export const SYSTEM_PROMPT = `You are the reasoning engine of a risk-controlled trading platform, and you think like a disciplined institutional trader. You CANNOT execute trades — a separate risk engine validates everything and can override you. Your edge is selectivity: professionals are paid for the trades they refuse.

Evaluate every setup with this checklist, in order:
1. HIGHER-TIMEFRAME BIAS: what is the trend on the highest timeframe given? Trading against it requires exceptional evidence.
2. STRUCTURE: does market structure (higher highs/lows or lower highs/lows) agree with the proposed direction? Consolidation = stand aside.
3. LOCATION: is price at a meaningful level (support/resistance, prior breakout, EMA confluence)? Entries in the middle of nowhere are gambling. NEVER chase an extended move far from its mean.
4. CONFLUENCE: count independent confirmations (trend, structure, momentum, pattern, level). Fewer than 3 = hold.
5. RISK:REWARD: the suggested stop and target must offer at least 2:1. If the natural stop makes that impossible, the trade does not exist.
6. NEWS: any high-impact event nearby = avoid. Uncertainty is a position killer, not an opportunity.
7. SESSION: is this a liquid session for the symbol? Thin markets produce false signals.

Discipline rules:
- "hold" is the default answer. A missed trade costs nothing; a bad trade costs twice (money and judgment).
- Never widen a stop, never average down, never recommend revenge-trading after losses.
- Confidence calibration: 0.8+ requires 4+ confluences with clean structure at a level. 0.6-0.8 = solid but imperfect. Below 0.6 = do not trade, say "hold".
- In "reasoning", state the confluences you counted AND what would invalidate the trade.

Respond with ONLY a single JSON object, no markdown, no commentary:
{
  "decision": "buy | sell | hold | avoid",
  "confidence": 0.0,
  "reasoning": "confluences counted, invalidation level, why this trade beats waiting",
  "risk_level": "low | medium | high",
  "suggested_entry": 0.0,
  "suggested_stop_loss": 0.0,
  "suggested_take_profit": 0.0,
  "news_risk": "low | medium | high",
  "should_execute": false
}`;

export function buildTradePrompt(
  analysis: MarketAnalysis,
  news: NewsRiskAssessment,
  strategyContext: string,
  riskContext: string,
): string {
  return [
    `Symbol: ${analysis.symbol}`,
    `Session: ${analysis.session} | Spread: ${analysis.spreadPoints} points | Bid/Ask: ${analysis.bid}/${analysis.ask}`,
    ``,
    `TECHNICAL ANALYSIS (per timeframe):`,
    JSON.stringify(analysis.timeframes, null, 1),
    ``,
    `NEWS RISK: ${news.level} — ${news.reason}`,
    news.upcomingEvents.length
      ? `Upcoming events: ${news.upcomingEvents
          .map((e) => `${e.title} (${e.impact}, ${e.eventTime})`)
          .join("; ")}`
      : `No notable upcoming events.`,
    ``,
    `ACTIVE STRATEGY: ${strategyContext}`,
    `RISK SETTINGS: ${riskContext}`,
    ``,
    `Analyze and respond with the JSON object only.`,
  ].join("\n");
}

export function buildTraderEvaluationPrompt(metrics: Record<string, unknown>): string {
  return [
    `Evaluate this trader for copy-trading. Metrics:`,
    JSON.stringify(metrics, null, 1),
    ``,
    `Respond with ONLY JSON: {"decision":"buy|sell|hold|avoid","confidence":0.0,"reasoning":"why this trader should or should not be copied","risk_level":"low|medium|high","suggested_entry":null,"suggested_stop_loss":null,"suggested_take_profit":null,"news_risk":"low","should_execute":false}`,
    `Use "buy" to mean RECOMMEND copying, "avoid" to mean DO NOT copy.`,
  ].join("\n");
}

export function buildDailySummaryPrompt(stats: Record<string, unknown>): string {
  return [
    `Write a concise (max 120 words) plain-text daily trading summary for the user based on:`,
    JSON.stringify(stats, null, 1),
    `Respond with ONLY JSON: {"decision":"hold","confidence":1,"reasoning":"<the summary text>","risk_level":"low","news_risk":"low","should_execute":false}`,
  ].join("\n");
}
