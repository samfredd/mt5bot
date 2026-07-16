import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { config } from "../../config.js";
import { mt5 } from "../mt5/client.js";
import { getBotState, setBotState } from "../system/state.js";
import { emergencyStopAll } from "../trading/service.js";
import { runScanner, getScannerConfig } from "../trading/scanner.js";
import { getAssistantConfig, chatWithAssistant } from "../assistant/service.js";
import { availableProviders, getActiveProvider } from "../ai/service.js";
import { getOperationalConfig, getOperationalConfigSummary, verifyMcpAccessToken } from "../system/operational-config.js";
import { latestNews } from "../news/service.js";
import { memorySummary } from "../memory/service.js";
import { intelligenceDashboard, searchIntelligence } from "../intelligence/service.js";

export interface McpIdentity {
  id: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "VIEWER";
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

function result(value: unknown): ToolResult {
  const normalized = jsonValue(value);
  return {
    content: [{ type: "text", text: JSON.stringify(normalized, null, 2) }],
    structuredContent: Array.isArray(normalized) ? { items: normalized } : (normalized as Record<string, unknown>),
  };
}

function failure(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

function requireRole(identity: McpIdentity, ...roles: McpIdentity["role"][]): void {
  if (!roles.includes(identity.role)) throw new Error(`This tool requires one of these roles: ${roles.join(", ")}.`);
}

function requireMutationAccess(settings: Awaited<ReturnType<typeof getOperationalConfig>>): void {
  if (!settings.mcpAllowMutations) throw new Error("MCP mutations are disabled in Settings.");
}

function requireTradingAccess(settings: Awaited<ReturnType<typeof getOperationalConfig>>): void {
  requireMutationAccess(settings);
  if (!settings.mcpAllowTradingActions) throw new Error("MCP trading actions are disabled in Settings.");
}

async function systemSnapshot(userId: string) {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const [account, positions, bot, risk, activeStrategies, pendingApprovals, daily, incidents] = await Promise.all([
    mt5.accountInfo().catch(() => null),
    mt5.positions().catch(() => []),
    getBotState(),
    prisma.riskSettings.findUnique({ where: { userId } }),
    prisma.strategy.findMany({ where: { userId, enabled: true }, select: { id: true, name: true, type: true } }),
    prisma.trade.count({ where: { userId, status: "PENDING_APPROVAL" } }),
    prisma.trade.aggregate({ where: { userId, closedAt: { gte: dayStart } }, _sum: { profit: true }, _count: true }),
    prisma.incident.count({ where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    account,
    bot,
    openPositions: positions,
    floatingPnl: positions.reduce((sum, position) => sum + position.profit, 0),
    today: { closedPnl: daily._sum.profit ?? 0, closedTrades: daily._count },
    risk,
    activeStrategies,
    pendingApprovals,
    activeIncidents: incidents,
  };
}

async function sanitizedSettings(userId: string) {
  const [risk, scanner, assistant, activeAiProvider, providers, operational] = await Promise.all([
    prisma.riskSettings.findUnique({ where: { userId } }),
    getScannerConfig(),
    getAssistantConfig(),
    getActiveProvider(),
    availableProviders(),
    getOperationalConfigSummary(),
  ]);
  return {
    risk,
    scanner,
    assistant,
    ai: { active: activeAiProvider, providers },
    operational,
    note: "Secret values are never exposed through MCP.",
  };
}

export function createMcpServer(identity: McpIdentity, settings: Awaited<ReturnType<typeof getOperationalConfig>>): McpServer {
  const actor = `mcp:${identity.email}`;
  const server = new McpServer({
    name: "mt5-ai-trading-system",
    version: "1.0.0",
  }, { capabilities: { logging: {} } });

  server.registerResource("system-overview", "mt5bot://system/overview", {
    title: "Live system overview",
    description: "Connected account, bot state, open positions, P/L, risk limits, strategies and incidents.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await systemSnapshot(identity.id), null, 2) }] }));

  server.registerResource("system-settings", "mt5bot://system/settings", {
    title: "Sanitized system settings",
    description: "Current risk, scanner, assistant, AI-provider and operational settings without secrets.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await sanitizedSettings(identity.id), null, 2) }] }));

  server.registerResource("recent-activity", "mt5bot://system/activity", {
    title: "Recent audited activity",
    description: "The latest audited system and trading activity.",
    mimeType: "application/json",
  }, async (uri) => {
    const rows = await prisma.auditLog.findMany({ where: { OR: [{ userId: identity.id }, { userId: null }] }, orderBy: { createdAt: "desc" }, take: 100 });
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(rows, null, 2) }] };
  });

  server.registerResource("trading-memory", "mt5bot://system/memory", {
    title: "Persistent trading memory",
    description: "Outcome statistics and lessons learned from completed trades.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await memorySummary(identity.id), null, 2) }] }));

  server.registerResource("market-intelligence", "mt5bot://system/intelligence", {
    title: "Market intelligence and research",
    description: "Source-ranked intelligence, developing stories, pending knowledge, source health, and ingestion status.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await intelligenceDashboard(), null, 2) }] }));

  server.registerTool("get_system_overview", {
    title: "Get live system overview",
    description: "Read the connected MT5 account, bot status, open positions, P/L, active strategies and safety state.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => { try { return result(await systemSnapshot(identity.id)); } catch (error) { return failure(error); } });

  server.registerTool("list_trades", {
    title: "List trades",
    description: "Read recent trade decisions and broker results for this user.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50),
      status: z.enum(["ANALYZED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "RISK_BLOCKED", "SUBMITTING", "PARTIALLY_FILLED", "UNKNOWN", "EXECUTED", "FAILED", "CLOSED", "CANCELLED"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit, status }) => {
    try {
      return result(await prisma.trade.findMany({
        where: { userId: identity.id, ...(status ? { status } : {}) },
        orderBy: { createdAt: "desc" }, take: limit,
        include: { strategy: { select: { name: true } }, approval: true },
      }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("list_strategies", {
    title: "List strategies",
    description: "Read all configured strategies, including enabled state and configuration.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => { try { return result(await prisma.strategy.findMany({ where: { userId: identity.id }, orderBy: { updatedAt: "desc" } })); } catch (error) { return failure(error); } });

  server.registerTool("get_system_settings", {
    title: "Get system settings",
    description: "Read sanitized risk, scanner, assistant, AI-provider and operational configuration. Secrets are omitted.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => { try { return result(await sanitizedSettings(identity.id)); } catch (error) { return failure(error); } });

  server.registerTool("get_recent_activity", {
    title: "Get recent activity",
    description: "Read audited system activity and risk/trade decisions.",
    inputSchema: { limit: z.number().int().min(1).max(200).default(50), category: z.string().max(50).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit, category }) => {
    try { return result(await prisma.auditLog.findMany({ where: { AND: [{ OR: [{ userId: identity.id }, { userId: null }] }, ...(category ? [{ category }] : [])] }, orderBy: { createdAt: "desc" }, take: limit })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("get_trading_memory", {
    title: "Get persistent trading memory",
    description: "Read outcome statistics and recent lessons the AI uses to calibrate future trade decisions.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => { try { return result(await memorySummary(identity.id)); } catch (error) { return failure(error); } });

  server.registerTool("search_market_intelligence", {
    title: "Search market intelligence",
    description: "Full-text search of provenance-preserving intelligence. Results distinguish verified facts, rumours, opinions, community content, and quarantined content.",
    inputSchema: { query: z.string().min(2).max(300), limit: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, limit }) => { try { return result(await searchIntelligence(query, limit)); } catch (error) { return failure(error); } });

  server.registerTool("get_market_news", {
    title: "Get market news",
    description: "Read the latest economic-calendar events and classified headlines used by the risk engine.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(30) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => { try { return result(await latestNews(limit)); } catch (error) { return failure(error); } });

  server.registerTool("ask_system_assistant", {
    title: "Ask the system assistant",
    description: "Ask a natural-language question using verified live system context. A requested change is only prepared and returns a confirmation token.",
    inputSchema: { message: z.string().min(1).max(4000) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ message }) => {
    try { return result(await chatWithAssistant({ userId: identity.id, actor, role: identity.role, message, channel: "web" })); }
    catch (error) { return failure(error); }
  });

  server.registerTool("confirm_system_change", {
    title: "Confirm prepared system change",
    description: "Apply a one-time change prepared by ask_system_assistant. MCP mutations and trading actions must be enabled; confirmation must equal CONFIRM.",
    inputSchema: { token: z.string().min(1).max(100), confirmation: z.literal("CONFIRM") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ token }) => {
    try {
      requireRole(identity, "ADMIN", "MANAGER"); requireTradingAccess(settings);
      const response = await chatWithAssistant({ userId: identity.id, actor, role: identity.role, confirmToken: token, channel: "web" });
      await audit({ actor, userId: identity.id, category: "system", action: "mcp_assistant_change_confirmed", detail: { response: response.message } });
      return result(response);
    } catch (error) { return failure(error); }
  });

  server.registerTool("control_bot", {
    title: "Control trading bot",
    description: "Start, pause, change mode, change paper-forward state, or operate Emergency Stop. Requires explicit Settings permissions and APPLY confirmation.",
    inputSchema: {
      action: z.enum(["start", "pause", "set_mode", "set_paper_forward", "emergency_stop", "reset_emergency_stop"]),
      mode: z.enum(["MANUAL", "SEMI_AUTO", "AUTO", "COPY"]).optional(),
      enabled: z.boolean().optional(),
      confirmation: z.literal("APPLY"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ action, mode, enabled }) => {
    try {
      requireRole(identity, "ADMIN", "MANAGER"); requireTradingAccess(settings);
      let output: unknown;
      if (action === "emergency_stop") output = { ok: true, closedPositions: await emergencyStopAll(actor, identity.id) };
      else if (action === "reset_emergency_stop") {
        requireRole(identity, "ADMIN");
        output = await setBotState({ emergencyStop: false, status: "paused" }, actor);
      } else if (action === "start") {
        const state = await getBotState();
        if (state.emergencyStop) throw new Error("Emergency Stop is active. Reset it first.");
        const risk = await prisma.riskSettings.findUnique({ where: { userId: identity.id } });
        if (!risk) throw new Error("Configure risk settings before starting the bot.");
        output = await setBotState({ status: "running" }, actor);
      } else if (action === "pause") output = await setBotState({ status: "paused" }, actor);
      else if (action === "set_mode") {
        if (!mode) throw new Error("mode is required for set_mode.");
        output = await setBotState({ mode }, actor);
      } else {
        if (enabled === undefined) throw new Error("enabled is required for set_paper_forward.");
        output = await setBotState({ paperForward: enabled }, actor);
      }
      await audit({ actor, userId: identity.id, category: "system", action: "mcp_bot_control", detail: { action, mode, enabled } });
      return result(output);
    } catch (error) { return failure(error); }
  });

  server.registerTool("set_strategy_enabled", {
    title: "Enable or disable strategy",
    description: "Change whether an existing strategy may generate trades. Requires explicit MCP permissions and APPLY confirmation.",
    inputSchema: { strategyId: z.string().min(1), enabled: z.boolean(), confirmation: z.literal("APPLY") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ strategyId, enabled }) => {
    try {
      requireRole(identity, "ADMIN", "MANAGER"); requireMutationAccess(settings);
      if (enabled) requireTradingAccess(settings);
      const existing = await prisma.strategy.findFirst({ where: { id: strategyId, userId: identity.id } });
      if (!existing) throw new Error("Strategy not found.");
      const strategy = await prisma.strategy.update({ where: { id: strategyId }, data: { enabled } });
      await audit({ actor, userId: identity.id, category: "strategy", action: "mcp_strategy_state_changed", detail: { strategyId, enabled } });
      return result(strategy);
    } catch (error) { return failure(error); }
  });

  server.registerTool("update_risk_limits", {
    title: "Update core risk limits",
    description: "Update a restricted set of validated risk limits. Requires explicit MCP trading permission and APPLY confirmation.",
    inputSchema: {
      maxRiskPerTradePct: z.number().positive().optional(),
      maxDailyLossPct: z.number().positive().optional(),
      maxLotSize: z.number().positive().optional(),
      maxOpenTrades: z.number().int().positive().optional(),
      maxTradesPerDay: z.number().int().positive().optional(),
      minRiskReward: z.number().positive().optional(),
      confirmation: z.literal("APPLY"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ confirmation: _confirmation, ...patch }) => {
    try {
      requireRole(identity, "ADMIN", "MANAGER"); requireTradingAccess(settings);
      if (Object.keys(patch).length === 0) throw new Error("Provide at least one risk limit.");
      const risk = await prisma.riskSettings.upsert({ where: { userId: identity.id }, create: { userId: identity.id, ...patch }, update: patch });
      await audit({ actor, userId: identity.id, category: "risk", action: "mcp_risk_limits_updated", detail: { patch } });
      return result(risk);
    } catch (error) { return failure(error); }
  });

  server.registerTool("run_market_scan", {
    title: "Run market scan",
    description: "Run the live scanner now. In Automatic mode a passing setup may execute, so trading permission and RUN SCAN confirmation are required.",
    inputSchema: { symbol: z.string().min(3).max(30).optional(), confirmation: z.literal("RUN SCAN") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ symbol }) => {
    try {
      requireRole(identity, "ADMIN", "MANAGER"); requireTradingAccess(settings);
      const scan = await runScanner("manual", { symbol });
      await audit({ actor, userId: identity.id, category: "trade", action: "mcp_market_scan_run", detail: { symbol } });
      return result(scan);
    } catch (error) { return failure(error); }
  });

  return server;
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<{ identity: McpIdentity; settings: Awaited<ReturnType<typeof getOperationalConfig>> } | null> {
  const settings = await getOperationalConfig();
  if (!settings.mcpEnabled) {
    reply.code(503).send({ jsonrpc: "2.0", error: { code: -32001, message: "MCP access is disabled in Settings." }, id: null });
    return null;
  }
  const origin = request.headers.origin;
  const allowedOrigins = new Set([config.FRONTEND_URL, ...settings.mcpAllowedOrigins]);
  if (origin && !allowedOrigins.has(origin)) {
    reply.code(403).send({ jsonrpc: "2.0", error: { code: -32002, message: "Origin is not allowed." }, id: null });
    return null;
  }
  const verified = await verifyMcpAccessToken(bearerToken(request));
  if (!verified) {
    reply.header("WWW-Authenticate", 'Bearer realm="mt5bot-mcp"').code(401).send({ jsonrpc: "2.0", error: { code: -32003, message: "Invalid or missing MCP access token." }, id: null });
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: verified.userId }, select: { id: true, email: true, role: true } });
  if (!user) {
    reply.code(401).send({ jsonrpc: "2.0", error: { code: -32003, message: "MCP user no longer exists." }, id: null });
    return null;
  }
  return { identity: user, settings };
}

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post("/mcp", async (request, reply) => {
    const access = await authenticate(request, reply);
    if (!access) return;
    const server = createMcpServer(access.identity, access.settings);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    try {
      await server.connect(transport);
      reply.hijack();
      reply.raw.once("close", () => { void cleanup(); });
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      await cleanup();
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal MCP server error." }, id: null }));
      }
    }
  });

  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).send({
    jsonrpc: "2.0", error: { code: -32000, message: "This server uses stateless Streamable HTTP; send MCP requests with POST." }, id: null,
  });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
