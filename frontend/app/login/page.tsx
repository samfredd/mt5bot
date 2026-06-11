"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";
import { IconShield, IconZap } from "@/components/icons";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "register") {
        await api("/auth/register", { method: "POST", body: { email, password } });
      }
      const res = await api<{ token: string }>("/auth/login", { method: "POST", body: { email, password } });
      setToken(res.token);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-dim text-white shadow-lg shadow-teal-950">
            <IconZap size={22} />
          </span>
          <div>
            <h1 className="text-xl font-semibold">MT5 AI Trading Bot</h1>
            <p className="mt-1 text-xs text-ink-faint">AI-assisted trading with a human in control</p>
          </div>
        </div>

        <form onSubmit={submit} className="card space-y-4">
          <div>
            <label htmlFor="email" className="label">Email</label>
            <input id="email" className="input" type="email" autoComplete="email"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="password" className="label">Password</label>
            <div className="relative">
              <input id="password" className="input pr-16" type={showPassword ? "text" : "password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              <button type="button" onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-md px-2 py-1 text-xs text-ink-faint hover:text-ink">
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {mode === "register" && <p className="mt-1 text-xs text-ink-faint">At least 8 characters.</p>}
          </div>
          {error && <p className="text-sm text-down" role="alert">{error}</p>}
          <button disabled={busy} className="btn-primary w-full">
            {busy ? "Signing in…" : mode === "login" ? "Sign in" : "Create account & sign in"}
          </button>
          <button type="button" onClick={() => setMode(mode === "login" ? "register" : "login")}
            className="w-full cursor-pointer text-center text-xs text-ink-dim transition-colors hover:text-ink">
            {mode === "login" ? "First time? Create an account" : "Have an account? Sign in"}
          </button>
        </form>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-ink-faint">
          <IconShield size={12} className="text-primary" />
          Demo mode by default — live trading stays locked behind 2FA.
        </p>
      </div>
    </div>
  );
}
