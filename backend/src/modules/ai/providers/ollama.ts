import { CircuitOpenError, circuitSnapshot, withResilience } from "../../../lib/resilience.js";
import { reportIncident, resolveIncidentByDedupeKey } from "../../incidents/service.js";
import { resolveProviderConfig } from "../provider-config.js";
import { getOperationalConfig } from "../../system/operational-config.js";
import type { GenerateRequest, ProviderStatus } from "./types.js";

export async function ollamaGenerate(request: GenerateRequest): Promise<string> {
  const { model: configuredModel, baseUrl } = await resolveProviderConfig("ollama");
  const model = request.model?.trim() || configuredModel;
  const { aiRequestTimeoutMs } = await getOperationalConfig();
  try {
    const response = await withResilience("ai", async () => {
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          system: request.system,
          prompt: request.prompt,
          stream: false,
          ...(request.json ? { format: "json" } : {}),
          options: { temperature: request.temperature },
        }),
        signal: AbortSignal.timeout(aiRequestTimeoutMs),
      });
      if (!res.ok) throw new Error(`ollama returned ${res.status}`);
      const payload = (await res.json()) as { response?: string };
      return payload.response ?? "";
    }, { retries: 2, baseDelayMs: 250, maxDelayMs: 1000, failureThreshold: 3, cooldownMs: 30_000 });
    await resolveIncidentByDedupeKey("ai:circuit-open", "system").catch(() => undefined);
    return response;
  } catch (error) {
    const state = circuitSnapshot("ai");
    if (error instanceof CircuitOpenError || (!Array.isArray(state) && state?.status === "open")) {
      await reportIncident({
        dedupeKey: "ai:circuit-open",
        severity: "CRITICAL",
        source: "ai",
        title: "Ollama circuit open",
        message: "Local model requests are blocked after repeated failures; trade vetting remains fail-closed.",
        context: { error: String(error) },
        minIntervalMs: 60_000,
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function ollamaStatus(): Promise<ProviderStatus> {
  const { model, baseUrl } = await resolveProviderConfig("ollama");
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { reachable: false, modelPresent: false };
    const body = (await res.json()) as { models?: { name?: string }[] };
    const base = (name: string) => name.split(":")[0];
    const names = (body.models ?? []).map((m) => m.name ?? "");
    return {
      reachable: true,
      modelPresent: names.includes(model) || names.some((name) => base(name) === base(model)),
    };
  } catch {
    return { reachable: false, modelPresent: false };
  }
}
