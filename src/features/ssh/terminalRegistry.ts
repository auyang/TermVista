import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

const MAX_PENDING_BYTES = 1024 * 1024;
const terminals = new Map<string, Terminal>();
const pending = new Map<string, Uint8Array[]>();
const pendingSizes = new Map<string, number>();

function writeAndAcknowledge(attemptId: string, terminal: Terminal, bytes: Uint8Array) {
  terminal.write(bytes, () => {
    void invoke("ssh_ack_output", { attemptId, bytes: bytes.byteLength }).catch(() => undefined);
  });
}

export function registerTerminal(attemptId: string, terminal: Terminal): () => void {
  terminals.set(attemptId, terminal);
  const chunks = pending.get(attemptId) ?? [];
  pending.delete(attemptId);
  pendingSizes.delete(attemptId);
  chunks.forEach((chunk) => writeAndAcknowledge(attemptId, terminal, chunk));
  return () => {
    if (terminals.get(attemptId) === terminal) terminals.delete(attemptId);
  };
}

export function deliverTerminalOutput(attemptId: string, payload: ArrayBuffer | Uint8Array) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const terminal = terminals.get(attemptId);
  if (terminal) {
    writeAndAcknowledge(attemptId, terminal, bytes);
    return;
  }
  const size = (pendingSizes.get(attemptId) ?? 0) + bytes.byteLength;
  if (size > MAX_PENDING_BYTES) {
    void invoke("ssh_cancel_connect", { attemptId }).catch(() => undefined);
    return;
  }
  pending.set(attemptId, [...(pending.get(attemptId) ?? []), bytes]);
  pendingSizes.set(attemptId, size);
}

export function clearTerminal(attemptId: string) {
  terminals.delete(attemptId);
  pending.delete(attemptId);
  pendingSizes.delete(attemptId);
}

export function getTerminalSelection(attemptId: string): string {
  return terminals.get(attemptId)?.getSelection() ?? "";
}

export function getTerminalRecentOutput(attemptId: string, maxLines = 80): string {
  const terminal = terminals.get(attemptId);
  if (!terminal || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > 200) return "";
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - maxLines);
  const lines: string[] = [];
  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").trim();
}
