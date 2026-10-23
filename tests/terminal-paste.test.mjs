import assert from "node:assert/strict";
import test from "node:test";
import { classifyTerminalPaste, resolveTerminalPaste } from "../src/features/terminal/pasteGuard.ts";

test("普通单行粘贴不增加确认步骤", () => {
  assert.equal(classifyTerminalPaste("ls -la", true), "normal");
});

test("多行粘贴和控制字符要求预览", () => {
  assert.equal(classifyTerminalPaste("echo first\necho second", true), "preview");
  assert.equal(classifyTerminalPaste("vim\u001b[A", true), "preview");
});

test("未连接或超过 1 MB 的粘贴被阻止", () => {
  assert.equal(classifyTerminalPaste("echo safe", false), "blocked-connection");
  assert.equal(classifyTerminalPaste("x".repeat(1024 * 1024 + 1), true), "blocked-size");
});

test("取消预览时不发送任何内容", () => {
  const sent = [];
  const pending = { text: "echo first\necho second", sessionId: "session-a" };
  const current = { connected: true, sessionId: "session-a" };

  assert.equal(resolveTerminalPaste("cancel", pending, true, current, (text) => sent.push(text)), false);
  assert.deepEqual(sent, []);
});

test("确认只把原始内容发送到仍然激活的同一会话", () => {
  const sent = [];
  const pending = { text: "echo first\necho second", sessionId: "session-a" };

  assert.equal(resolveTerminalPaste("send", pending, true, { connected: true, sessionId: "session-a" }, (text) => sent.push(text)), true);
  assert.deepEqual(sent, [pending.text]);
  assert.equal(resolveTerminalPaste("send", pending, true, { connected: true, sessionId: "session-b" }, (text) => sent.push(text)), false);
  assert.equal(resolveTerminalPaste("send", pending, false, { connected: true, sessionId: "session-a" }, (text) => sent.push(text)), false);
  assert.deepEqual(sent, [pending.text]);
});
