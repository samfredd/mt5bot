import { describe, expect, it } from "vitest";
import { decodeJwtPayload, getStoredValidToken, isTokenExpired } from "./auth";

const token = (payload: Record<string, unknown>) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${body}.signature`;
};

function storageWith(value: string | null) {
  let stored = value;
  return {
    getItem: () => stored,
    setItem: (_key: string, next: string) => { stored = next; },
    removeItem: () => { stored = null; },
    value: () => stored,
  };
}

describe("JWT expiry handling", () => {
  it("decodes the JWT payload", () => {
    expect(decodeJwtPayload(token({ sub: "u1", exp: 200 }))).toEqual({ sub: "u1", exp: 200 });
  });

  it("treats expired and malformed tokens as expired", () => {
    expect(isTokenExpired(token({ exp: 99 }), 100)).toBe(true);
    expect(isTokenExpired(token({ exp: 101 }), 100)).toBe(false);
    expect(isTokenExpired("invalid", 100)).toBe(true);
  });

  it("treats a token with no exp claim as a permanent (never-expiring) session", () => {
    expect(isTokenExpired(token({ sub: "u1" }), 100)).toBe(false);
    const storage = storageWith(token({ sub: "u1" }));
    expect(getStoredValidToken(storage, 100)).toBe(token({ sub: "u1" }));
    expect(storage.value()).not.toBeNull();
  });

  it("removes an expired local-storage token before returning it", () => {
    const storage = storageWith(token({ exp: 99 }));
    expect(getStoredValidToken(storage, 100)).toBeNull();
    expect(storage.value()).toBeNull();
  });
});
