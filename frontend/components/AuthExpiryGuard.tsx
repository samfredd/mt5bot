"use client";

import { useEffect } from "react";
import { decodeJwtPayload, getToken, setToken, TOKEN_KEY } from "@/lib/auth";

export function AuthExpiryGuard() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      const token = getToken();
      if (!token) return;
      const payload = decodeJwtPayload(token);
      // No `exp` → permanent session (JWT_EXPIRES_IN=never): never schedule a logout.
      if (typeof payload?.exp !== "number") return;
      const delay = payload.exp * 1000 - Date.now();
      timer = setTimeout(() => {
        setToken(null);
        window.location.href = "/login?reason=expired";
      }, Math.max(0, delay));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === TOKEN_KEY) schedule();
    };
    schedule();
    window.addEventListener("storage", onStorage);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}
