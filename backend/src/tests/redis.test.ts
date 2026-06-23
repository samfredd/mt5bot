import { beforeEach, describe, expect, it } from "vitest";
import {
  __setRedisClientForTests,
  acquireLease,
  readJson,
  releaseLease,
  renewLease,
  writeJson,
} from "../lib/redis.js";

class FakeRedis {
  values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    const nx = args.includes("NX");
    if (nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(_script: string, _keys: number, key: string, owner: string) {
    if (this.values.get(key) !== owner) return 0;
    if (_script.includes("del")) this.values.delete(key);
    return 1;
  }

  async ping() {
    return "PONG";
  }
}

describe("redis helpers", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
    __setRedisClientForTests(redis);
  });

  it("stores and reads JSON values", async () => {
    expect(await readJson("missing")).toBeNull();
    expect(await writeJson("state", { status: "running" }, 60)).toBe(true);
    expect(await readJson("state")).toEqual({ status: "running" });
  });

  it("allows only one lease owner and only that owner can release it", async () => {
    expect(await acquireLease("scheduler:analysis", "owner-a", 30_000)).toBe(true);
    expect(await acquireLease("scheduler:analysis", "owner-b", 30_000)).toBe(false);
    expect(await releaseLease("scheduler:analysis", "owner-b")).toBe(false);
    expect(await releaseLease("scheduler:analysis", "owner-a")).toBe(true);
  });

  it("renews a lease only for its current owner", async () => {
    await acquireLease("scheduler:lab", "owner-a", 30_000);
    expect(await renewLease("scheduler:lab", "owner-b", 30_000)).toBe(false);
    expect(await renewLease("scheduler:lab", "owner-a", 30_000)).toBe(true);
  });

  it("fails closed when the client throws", async () => {
    __setRedisClientForTests({
      get: async () => { throw new Error("down"); },
      set: async () => { throw new Error("down"); },
      del: async () => { throw new Error("down"); },
      eval: async () => { throw new Error("down"); },
      ping: async () => { throw new Error("down"); },
    });

    expect(await readJson("state")).toBeNull();
    expect(await writeJson("state", {})).toBe(false);
    expect(await acquireLease("job", "owner", 1000)).toBe(false);
  });
});
