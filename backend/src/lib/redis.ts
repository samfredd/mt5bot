import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "./logger.js";

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>;
  ping(): Promise<string>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
};

let client: RedisLike | null = null;

function redis(): RedisLike {
  if (!client) {
    const instance = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt: number) => Math.min(attempt * 250, 2000),
    });
    instance.on("error", (error: Error) => logger.warn({ error: String(error) }, "redis unavailable"));
    client = instance;
    return instance;
  }
  return client;
}

export function __setRedisClientForTests(value: RedisLike | null): void {
  client = value;
}

export async function redisAvailable(): Promise<boolean> {
  try {
    return (await redis().ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function readJson<T>(key: string): Promise<T | null> {
  try {
    const value = await redis().get(key);
    return value === null ? null : JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function writeJson(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
  try {
    const result = ttlSeconds
      ? await redis().set(key, JSON.stringify(value), "EX", ttlSeconds)
      : await redis().set(key, JSON.stringify(value));
    return result === "OK";
  } catch {
    return false;
  }
}

export async function deleteKey(key: string): Promise<boolean> {
  try {
    return (await redis().del(key)) > 0;
  } catch {
    return false;
  }
}

export async function acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean> {
  try {
    return (await redis().set(`lock:${key}`, owner, "PX", ttlMs, "NX")) === "OK";
  } catch {
    return false;
  }
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

export async function releaseLease(key: string, owner: string): Promise<boolean> {
  try {
    return Number(await redis().eval(RELEASE_SCRIPT, 1, `lock:${key}`, owner)) === 1;
  } catch {
    return false;
  }
}

export async function renewLease(key: string, owner: string, ttlMs: number): Promise<boolean> {
  try {
    return Number(await redis().eval(RENEW_SCRIPT, 1, `lock:${key}`, owner, String(ttlMs))) === 1;
  } catch {
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  const current = client;
  client = null;
  if (!current) return;
  try {
    if (current.quit) await current.quit();
    else current.disconnect?.();
  } catch {
    current.disconnect?.();
  }
}
