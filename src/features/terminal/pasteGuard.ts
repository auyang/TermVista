export type TerminalPastePreview = { text: string; sessionId: string };

export function classifyTerminalPaste(text: string, connected: boolean): "blocked-connection" | "blocked-size" | "preview" | "normal" {
  if (!connected) return "blocked-connection";
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) return "blocked-size";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 31 || code === 127) return "preview";
  }
  return "normal";
}

export function resolveTerminalPaste(
  choice: "cancel" | "send",
  pending: TerminalPastePreview | null,
  active: boolean,
  current: { connected: boolean; sessionId?: string } | undefined,
  send: (text: string) => void,
) {
  if (
    choice !== "send"
    || !pending
    || !active
    || !current?.connected
    || current.sessionId !== pending.sessionId
  ) return false;
  send(pending.text);
  return true;
}
