export async function runCoordinatedAnalysisCycle(input: {
  protect: () => Promise<void>;
  newTradeWork: () => Promise<void>;
  withLease: (work: () => Promise<void>) => Promise<unknown>;
}) {
  await input.protect();
  await input.withLease(input.newTradeWork);
}
