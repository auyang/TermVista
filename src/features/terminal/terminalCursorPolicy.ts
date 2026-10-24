export function shouldBlinkTerminalCursor(
  state: string | undefined,
  sessionId: string | undefined,
  preferenceEnabled: boolean,
) {
  return preferenceEnabled && state === "connected" && Boolean(sessionId);
}
