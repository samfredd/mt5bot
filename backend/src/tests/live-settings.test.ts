import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  updatedUsers: [] as Record<string, unknown>[],
  statePatches: [] as Record<string, unknown>[],
  audits: [] as string[],
}));

vi.mock("../config.js", () => ({
  config: {
    REQUIRE_2FA: false,
    LIVE_TRADING_ENABLED: false,
  },
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ id: "u1", totpEnabled: false, totpSecret: null })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.updatedUsers.push(data);
        return { id: "u1", email: "admin@example.com", role: "ADMIN", ...data };
      }),
    },
    telegramUser: { create: vi.fn(async () => ({})) },
    whatsappUser: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("../lib/audit.js", () => ({
  audit: vi.fn(async ({ action }: { action: string }) => { h.audits.push(action); }),
}));

vi.mock("../modules/system/state.js", () => ({
  // Live 2FA off → enabling live trading needs no TOTP (the Settings-toggle path).
  getBotState: vi.fn(async () => ({ requireLiveTwoFactor: false })),
  setBotState: vi.fn(async (patch: Record<string, unknown>) => {
    h.statePatches.push(patch);
    return { status: "stopped", mode: "MANUAL", emergencyStop: false, paperForward: false, ...patch };
  }),
}));

vi.mock("../modules/auth/service.js", () => ({
  registerUser: vi.fn(),
  verifyLogin: vi.fn(),
  verifyTotp: vi.fn(() => false),
  revokeUserTokens: vi.fn(),
}));

describe("live trading Settings toggle", () => {
  beforeEach(() => {
    h.updatedUsers = [];
    h.statePatches = [];
    h.audits = [];
    vi.resetModules();
  });

  it("enables live trading from persisted Settings state without an env kill switch", async () => {
    const app = Fastify();
    app.decorate("authenticate", async (req) => {
      req.user = { id: "u1", email: "admin@example.com", role: "ADMIN" };
    });
    app.decorate("requireRole", () => async (req) => {
      req.user = { id: "u1", email: "admin@example.com", role: "ADMIN" };
    });

    const { authRoutes } = await import("../modules/auth/routes.js");
    await app.register(authRoutes);

    const res = await app.inject({ method: "POST", url: "/auth/live/enable", payload: {} });

    expect(res.statusCode).toBe(200);
    expect(h.updatedUsers).toContainEqual({ liveTradingEnabled: true });
    expect(h.statePatches).toContainEqual({ liveTradingEnabled: true, demoMode: false });
    expect(h.audits).toContain("live_trading_enabled_by_user");
  });

  it("disables live trading and returns bot state to demo mode", async () => {
    const app = Fastify();
    app.decorate("authenticate", async (req) => {
      req.user = { id: "u1", email: "admin@example.com", role: "ADMIN" };
    });
    app.decorate("requireRole", () => async (req) => {
      req.user = { id: "u1", email: "admin@example.com", role: "ADMIN" };
    });

    const { authRoutes } = await import("../modules/auth/routes.js");
    await app.register(authRoutes);

    const res = await app.inject({ method: "POST", url: "/auth/live/disable", payload: {} });

    expect(res.statusCode).toBe(200);
    expect(h.updatedUsers).toContainEqual({ liveTradingEnabled: false });
    expect(h.statePatches).toContainEqual({ liveTradingEnabled: false, demoMode: true });
    expect(h.audits).toContain("live_trading_disabled_by_user");
  });
});
