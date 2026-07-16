export const TOKEN_KEY = "mt5bot_token";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface JwtPayload {
  exp?: number;
  [key: string]: unknown;
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as JwtPayload;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return true; // malformed/undecodable → treat as invalid
  // No `exp` claim means a permanent session (JWT_EXPIRES_IN=never): never expires.
  if (typeof payload.exp !== "number") return false;
  return payload.exp <= nowSeconds;
}

export function getStoredValidToken(
  storage: StorageLike,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  const token = storage.getItem(TOKEN_KEY);
  if (!token) return null;
  if (isTokenExpired(token, nowSeconds)) {
    storage.removeItem(TOKEN_KEY);
    return null;
  }
  return token;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return getStoredValidToken(window.localStorage);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event("mt5bot-auth-changed"));
}
