import { redisAvailable } from "./redis.js";
import { circuitSnapshot, type CircuitState } from "./resilience.js";

export async function operationalHealth(): Promise<{ redis: boolean; circuits: CircuitState[] }> {
  const snapshot = circuitSnapshot();
  return {
    redis: await redisAvailable(),
    circuits: Array.isArray(snapshot) ? snapshot : [],
  };
}
