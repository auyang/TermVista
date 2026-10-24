import assert from "node:assert/strict";
import test from "node:test";
import { shouldBlinkTerminalCursor } from "../src/features/terminal/terminalCursorPolicy.ts";

test("只在可输入的已连接会话中按用户设置闪烁光标", () => {
  assert.equal(shouldBlinkTerminalCursor("connected", "session-a", true), true);
  assert.equal(shouldBlinkTerminalCursor("connected", undefined, true), false);
  assert.equal(shouldBlinkTerminalCursor("connecting", "session-a", true), false);
  assert.equal(shouldBlinkTerminalCursor("disconnected", "session-a", true), false);
  assert.equal(shouldBlinkTerminalCursor("error", "session-a", true), false);
  assert.equal(shouldBlinkTerminalCursor("connected", "session-a", false), false);
});
