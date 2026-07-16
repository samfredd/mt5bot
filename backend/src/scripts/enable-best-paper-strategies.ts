import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { StrategyConfigSchema } from "../modules/strategy/types.js";

const selected = new Map([
  ["Swing Trader (H4/D1)", { returnPct: 1.68, profitFactor: 1.93, profitableFolds: 2, folds: 4 }],
  ["Selective Intraday Trend (M15/H1) — Liquid FX", { returnPct: 1.24, profitFactor: 1.11, profitableFolds: 2, folds: 4 }],
]);

async function main() {
  const stateRow = await prisma.systemSetting.findUnique({ where: { key: "bot_state" } });
  const state = stateRow?.value as { paperForward?: boolean } | undefined;
  if (!state?.paperForward) {
    throw new Error("Refusing to enable unvalidated strategies unless paper-forward mode is active.");
  }

  const strategies = await prisma.strategy.findMany({ where: { name: { in: [...selected.keys()] } } });
  if (strategies.length !== selected.size) {
    throw new Error(`Expected ${selected.size} selected strategies, found ${strategies.length}.`);
  }

  for (const strategy of strategies) {
    const config = StrategyConfigSchema.parse(strategy.config);
    await prisma.strategy.update({
      where: { id: strategy.id },
      data: { enabled: true, config: { ...config, validationStatus: "paper" } as object },
    });
    await audit({
      actor: "system:paper-strategy-selection",
      userId: strategy.userId,
      category: "strategy",
      action: "strategy_enabled_for_paper_forward",
      detail: { id: strategy.id, name: strategy.name, evidence: selected.get(strategy.name), paperForward: true },
    });
  }

  console.log(JSON.stringify({ enabled: strategies.map((strategy) => strategy.name), paperForward: true }, null, 2));
}

main().finally(() => prisma.$disconnect());
