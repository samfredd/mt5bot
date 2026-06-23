import { mt5 } from "../mt5/client.js";
import { broadcast } from "../ws/hub.js";

const money = (value: number) => Number(value.toFixed(2));

export function floatingPnlSnapshot<T extends { ticket: string; symbol: string; profit: number }>(positions: T[], now = new Date()) {
  const normalized = positions.map((position) => ({ ticket: position.ticket, symbol: position.symbol, profit: money(position.profit) }));
  return {
    floatingPnl: money(normalized.reduce((sum, position) => sum + position.profit, 0)),
    positions: normalized,
    time: now.toISOString(),
  };
}

let publishing = false;
export async function publishFloatingPnl() {
  if (publishing) return;
  publishing = true;
  try {
    const positions = await mt5.positions();
    broadcast("floating_pnl", floatingPnlSnapshot(positions));
  } finally {
    publishing = false;
  }
}
