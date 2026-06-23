export function buildLiveTradingRequestBody(enable: boolean, token: string | null): Record<string, string> {
  if (!enable) return {};
  const trimmed = token?.trim();
  return trimmed ? { token: trimmed } : {};
}
