import { getToken, setToken } from "./auth";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";
export { getToken, setToken } from "./auth";

export interface ApiIssue {
  field?: string;
  path?: Array<string | number>;
  reason?: string;
  message?: string;
  code?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issues: ApiIssue[] = [],
    public readonly action?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function apiErrorFromPayload(status: number, payload: unknown): ApiError {
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const issues = Array.isArray(data.issues) ? data.issues as ApiIssue[] : [];
  const issueReason = issues.map((issue) => {
    const field = issue.field ?? issue.path?.join(".") ?? "request";
    return `${field}: ${issue.reason ?? issue.message ?? "invalid value"}`;
  }).join("; ");
  const title = typeof data.error === "string" ? data.error : `Request failed (${status})`;
  const reason = typeof data.reason === "string" ? data.reason : issueReason;
  const action = typeof data.action === "string" ? data.action : undefined;
  const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
  const parts = [title, reason && reason !== title ? `Reason: ${reason}` : "", action ? `Action: ${action}` : "", requestId ? `Reference: ${requestId}` : ""].filter(Boolean);
  return new ApiError(parts.join("\n"), status, issues, action, requestId);
}

export function webSocketProtocols(): string[] {
  const token = getToken();
  return token ? ["mt5bot", token] : ["mt5bot"];
}

/** Revoke the session server-side (all devices), drop the local token, go to login. */
export async function logout() {
  try {
    await api("/auth/logout", { method: "POST", body: {} });
  } catch {
    /* best-effort — clear locally regardless */
  }
  setToken(null);
  if (typeof window !== "undefined") window.location.href = "/login";
}

/** End the session for real: drop the local token and bounce to login. */
function endSession() {
  if (typeof window === "undefined") return;
  setToken(null);
  window.location.href = "/login";
}

function doFetch(path: string, opts: { method?: string; body?: unknown }): Promise<Response> {
  const token = getToken();
  return fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      // Only claim a JSON body when one is actually sent — Fastify rejects
      // an empty body with content-type: application/json.
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = getToken();
  if (!token && typeof window !== "undefined" && !path.startsWith("/auth/")) {
    window.location.href = "/login?reason=expired";
    throw new ApiError("Session expired. Action: Sign in again to continue.", 401);
  }
  let res = await doFetch(path, opts);

  // A 401 can be a genuinely dead session (revoked / bad token) OR a one-off
  // blip on a single request (server restart mid-flight, transient gateway
  // hiccup). Don't nuke the whole session on the first one: confirm it's real
  // with a single retry, and only log out if the retry 401s too. This is safe
  // because every non-/auth/ 401 is raised by the auth preHandler BEFORE the
  // route runs, so the request had no side effects — even a POST can't double-fire.
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/")) {
    if (!getToken()) {
      endSession();
      throw new ApiError("Session expired. Action: Sign in again to continue.", 401);
    }
    res = await doFetch(path, opts);
    if (res.status === 401) endSession();
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiErrorFromPayload(res.status, data);
  return data as T;
}
