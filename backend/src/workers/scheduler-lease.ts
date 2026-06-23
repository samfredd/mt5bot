import { randomUUID } from "node:crypto";
import { acquireLease, releaseLease, renewLease } from "../lib/redis.js";

export async function withSchedulerLease<T>(
  job: string,
  ttlMs: number,
  work: () => Promise<T>,
): Promise<T | null> {
  const owner = randomUUID();
  if (!(await acquireLease(`scheduler:${job}`, owner, ttlMs))) return null;
  const renewal = setInterval(() => {
    void renewLease(`scheduler:${job}`, owner, ttlMs);
  }, Math.max(Math.floor(ttlMs / 2), 1000));
  renewal.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(renewal);
    await releaseLease(`scheduler:${job}`, owner);
  }
}
