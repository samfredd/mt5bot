import type { FastifyInstance } from "fastify";
import { sentimentForSymbol } from "./service.js";

export async function sentimentRoutes(app: FastifyInstance) {
  app.get("/api/sentiment/:symbol", { preHandler: [app.authenticate] }, async (req) => {
    const { symbol } = req.params as { symbol: string };
    return sentimentForSymbol(symbol);
  });
}
