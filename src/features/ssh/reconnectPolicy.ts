const BASE_DELAYS_MS = [2000, 4000, 8000, 16000, 30000] as const;
export const MAX_AUTO_RECONNECT_ATTEMPTS = 5;

const RETRYABLE_NETWORK_ERRORS = new Set([
  "connectionTimeout",
  "connectionRefused",
  "connectionFailed",
  "dnsResolutionFailed",
  "serverClosed",
]);

export function reconnectDelayMs(attempt: number, random: () => number = Math.random) {
  const index = Math.min(Math.max(Math.floor(attempt) - 1, 0), BASE_DELAYS_MS.length - 1);
  const sample = Math.min(Math.max(random(), 0), 1);
  return Math.round(BASE_DELAYS_MS[index] * (0.8 + sample * 0.4));
}

export function isRetryableNetworkError(code?: string) {
  return RETRYABLE_NETWORK_ERRORS.has(code ?? "");
}

export function canReconnectFromTerminalEnter(state: string | undefined, code?: string) {
  if (code && !isRetryableNetworkError(code)) return false;
  return state === "disconnected" || state === "error" && isRetryableNetworkError(code);
}
