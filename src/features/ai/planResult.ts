export type AiPlanResult =
  | { kind: "command"; summary: string; command: string }
  | { kind: "codeEdit"; summary: string; replacement: string }
  | { kind: "question"; summary: string };

const MAX_COMMAND_BYTES = 4096;
const MAX_REPLACEMENT_BYTES = 2 * 1024 * 1024;

export function parseAiPlanResult(text: string): AiPlanResult | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || !record.summary.trim() || record.summary.length > 2000) return null;
  if (record.kind === "command") {
    if (!hasOnlyKeys(record, ["kind", "summary", "command"])) return null;
    if (typeof record.command !== "string" || !record.command.trim()) return null;
    if (new TextEncoder().encode(record.command).byteLength > MAX_COMMAND_BYTES) return null;
    if ([...record.command].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })) return null;
    return { kind: "command", summary: record.summary.trim(), command: record.command };
  }
  if (record.kind === "codeEdit") {
    if (!hasOnlyKeys(record, ["kind", "summary", "replacement"])) return null;
    if (typeof record.replacement !== "string" || record.replacement.includes("\0")) return null;
    if (new TextEncoder().encode(record.replacement).byteLength > MAX_REPLACEMENT_BYTES) return null;
    return { kind: "codeEdit", summary: record.summary.trim(), replacement: record.replacement };
  }
  if (record.kind === "question" && hasOnlyKeys(record, ["kind", "summary"])) {
    return { kind: "question", summary: record.summary.trim() };
  }
  return null;
}

function hasOnlyKeys(record: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
