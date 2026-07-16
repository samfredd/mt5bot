import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../modules/mcp/server.js";

const connected: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];

afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }));
});

async function setup(flags: { mcpAllowMutations?: boolean; mcpAllowTradingActions?: boolean } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(
    { id: "user-1", email: "admin@example.com", role: "ADMIN" },
    {
      mcpEnabled: true,
      mcpAllowMutations: flags.mcpAllowMutations ?? false,
      mcpAllowTradingActions: flags.mcpAllowTradingActions ?? false,
    } as never,
  );
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  connected.push({ client, server });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("MT5 MCP server", () => {
  it("advertises system resources and a broad tool catalog", async () => {
    const client = await setup();
    const [{ tools }, { resources }] = await Promise.all([client.listTools(), client.listResources()]);
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      "get_system_overview",
      "list_trades",
      "list_strategies",
      "get_system_settings",
      "get_recent_activity",
      "get_trading_memory",
      "search_market_intelligence",
      "get_market_news",
      "ask_system_assistant",
      "confirm_system_change",
      "control_bot",
      "set_strategy_enabled",
      "update_risk_limits",
      "run_market_scan",
    ]));
    expect(resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
      "mt5bot://system/overview",
      "mt5bot://system/settings",
      "mt5bot://system/activity",
      "mt5bot://system/memory",
      "mt5bot://system/intelligence",
    ]));
    expect(tools.find((tool) => tool.name === "get_system_overview")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "control_bot")?.annotations?.destructiveHint).toBe(true);
  });

  it("fails closed when mutation permission is disabled", async () => {
    const client = await setup({ mcpAllowMutations: false, mcpAllowTradingActions: false });
    const response = await client.callTool({ name: "control_bot", arguments: { action: "pause", confirmation: "APPLY" } });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("mutations are disabled") }),
    ]));
  });
});
