import { readJson, writeJson } from "./redis.js";

export type CircuitStatus = "closed" | "open" | "half_open";

export interface CircuitState {
  dependency: string;
  status: CircuitStatus;
  failures: number;
  openedAt: number | null;
  updatedAt: number;
}

export interface ResilienceOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class CircuitOpenError extends Error {
  constructor(public readonly dependency: string) {
    super(`${dependency} circuit is open`);
    this.name = "CircuitOpenError";
  }
}

const circuits = new Map<string, CircuitState>();
const circuitKey = (dependency: string) => `circuit:${dependency}`;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function loadState(dependency: string, now: number): Promise<CircuitState> {
  const cached = circuits.get(dependency);
  if (cached) return cached;
  const stored = await readJson<CircuitState>(circuitKey(dependency));
  const state = stored ?? { dependency, status: "closed", failures: 0, openedAt: null, updatedAt: now };
  circuits.set(dependency, state);
  return state;
}

async function saveState(state: CircuitState): Promise<void> {
  circuits.set(state.dependency, state);
  await writeJson(circuitKey(state.dependency), state, 24 * 60 * 60);
}

export async function withResilience<T>(
  dependency: string,
  operation: () => Promise<T>,
  options: ResilienceOptions = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const failureThreshold = options.failureThreshold ?? 3;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  let state = await loadState(dependency, now());
  if (state.status === "open") {
    if (state.openedAt !== null && now() - state.openedAt < cooldownMs) {
      throw new CircuitOpenError(dependency);
    }
    state = { ...state, status: "half_open", updatedAt: now() };
    await saveState(state);
  } else if (state.status === "half_open") {
    throw new CircuitOpenError(dependency);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await operation();
      await saveState({ dependency, status: "closed", failures: 0, openedAt: null, updatedAt: now() });
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const exponential = Math.min(baseDelayMs * (2 ** attempt), maxDelayMs);
        const delay = Math.min(exponential + Math.floor(random() * baseDelayMs), maxDelayMs);
        await sleep(delay);
      }
    }
  }

  const failures = state.status === "half_open" ? failureThreshold : state.failures + 1;
  const opened = failures >= failureThreshold;
  await saveState({
    dependency,
    status: opened ? "open" : "closed",
    failures,
    openedAt: opened ? now() : null,
    updatedAt: now(),
  });
  throw lastError;
}

export function circuitSnapshot(dependency?: string): CircuitState | CircuitState[] | null {
  if (dependency) return circuits.get(dependency) ?? null;
  return [...circuits.values()];
}

export function __resetCircuitsForTests(): void {
  circuits.clear();
}
