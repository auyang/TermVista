const commandInputs = new Map<string, (value: string) => void>();
const MAX_INSERT_BYTES = 4096;

export function registerCommandInput(attemptId: string, setValue: (value: string) => void): () => void {
  commandInputs.set(attemptId, setValue);
  return () => {
    if (commandInputs.get(attemptId) === setValue) commandInputs.delete(attemptId);
  };
}

export function insertAiCommand(attemptId: string, command: string): boolean {
  const input = commandInputs.get(attemptId);
  if (!input || !command) return false;
  for (const character of command) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  if (new TextEncoder().encode(command).byteLength > MAX_INSERT_BYTES) return false;
  input(command);
  return true;
}
