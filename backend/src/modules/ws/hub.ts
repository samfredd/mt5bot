import type { WebSocket } from "ws";

/** Simple broadcast hub for real-time dashboard updates. */
const clients = new Set<WebSocket>();

export function addClient(socket: WebSocket) {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
}

export function broadcast(event: string, data: unknown) {
  const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
  for (const c of clients) {
    if (c.readyState === 1) c.send(msg);
  }
}
