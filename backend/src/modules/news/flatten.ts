type Impact = "LOW" | "MEDIUM" | "HIGH";

const IMPACT_RANK: Record<Impact, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

export function positionsForNewsFlatten<T extends { ticket: string; symbol: string }>(input: {
  enabled: boolean;
  leadMinutes: number;
  minimumImpact: Impact;
  symbols: string[];
  events: { currency: string | null; impact: Impact; eventTime: Date }[];
  positions: T[];
  now?: Date;
}): T[] {
  if (!input.enabled || input.symbols.length === 0) return [];
  const now = input.now ?? new Date();
  const latest = now.getTime() + Math.max(0, input.leadMinutes) * 60_000;
  const currencies = new Set(input.events
    .filter((event) => event.eventTime.getTime() >= now.getTime() && event.eventTime.getTime() <= latest)
    .filter((event) => IMPACT_RANK[event.impact] >= IMPACT_RANK[input.minimumImpact])
    .map((event) => event.currency?.toUpperCase())
    .filter((currency): currency is string => !!currency));
  const scope = new Set(input.symbols.map((symbol) => symbol.toUpperCase()));
  return input.positions.filter((position) => {
    const symbol = position.symbol.toUpperCase();
    return scope.has(symbol) && [...currencies].some((currency) => symbol.includes(currency));
  });
}
