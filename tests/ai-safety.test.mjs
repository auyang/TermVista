import test from "node:test";
import assert from "node:assert/strict";
import { insertAiCommand, registerCommandInput } from "../src/features/terminal/commandBarRegistry.ts";
import { parseAiPlanResult } from "../src/features/ai/planResult.ts";
import { useAiStore } from "../src/features/ai/aiStore.ts";

test("AI command insertion only fills the registered input and never submits it", () => {
  let inserted = "";
  const unregister = registerCommandInput("tab-a", (value) => { inserted = value; });
  try {
    assert.equal(insertAiCommand("tab-a", "df -h"), true);
    assert.equal(inserted, "df -h");
    assert.equal(insertAiCommand("tab-a", "id\nrm -rf /"), false);
    assert.equal(insertAiCommand("tab-a", "echo \u001b"), false);
    assert.equal(inserted, "df -h");
  } finally {
    unregister();
  }
  assert.equal(insertAiCommand("tab-a", "pwd"), false);
});

test("plan parser accepts a bounded single-line command suggestion", () => {
  assert.deepEqual(parseAiPlanResult('{"kind":"command","summary":"查看磁盘空间","command":"df -h"}'), {
    kind: "command",
    summary: "查看磁盘空间",
    command: "df -h",
  });
  assert.equal(parseAiPlanResult('{"kind":"command","summary":"多行","command":"id\\nwhoami"}'), null);
});

test("plan parser bounds code edits and rejects malformed response shapes", () => {
  assert.deepEqual(parseAiPlanResult('{"kind":"codeEdit","summary":"改一行","replacement":"hello\\n"}'), {
    kind: "codeEdit",
    summary: "改一行",
    replacement: "hello\n",
  });
  assert.equal(parseAiPlanResult("not JSON"), null);
  assert.equal(parseAiPlanResult(JSON.stringify({ kind: "codeEdit", summary: "too large", replacement: "x".repeat(2 * 1024 * 1024 + 1) })), null);
  assert.equal(parseAiPlanResult(JSON.stringify({ kind: "command", summary: "too large", command: "x".repeat(4097) })), null);
  assert.equal(parseAiPlanResult('{"kind":"command","summary":"查看","command":"id","execute":true}'), null);
});

test("AI conversations and stream events remain isolated by SSH session", () => {
  const store = useAiStore.getState();
  store.clearSession("session-a");
  store.clearSession("session-b");
  store.beginStream("session-a", "request-a", "主机 A 的问题", "ask");
  store.applyDelta("session-a", "request-a", "主机 A 回复");
  store.applyUsage("session-a", "request-a");
  assert.equal(useAiStore.getState().conversations["session-a"].at(-1).usage, undefined);
  store.applyUsage("session-a", "request-a", 12, 5);
  store.beginStream("session-b", "request-b", "主机 B 的问题", "ask");
  store.applyDelta("session-a", "request-b", "不应串流到 A");
  store.applyDelta("session-b", "request-a", "不应串流到 B");
  store.applyDelta("session-b", "request-b", "主机 B 回复");

  const conversations = useAiStore.getState().conversations;
  assert.match(conversations["session-a"].at(-1).content, /主机 A 回复/);
  assert.doesNotMatch(conversations["session-a"].at(-1).content, /不应串流|主机 B 回复/);
  assert.match(conversations["session-b"].at(-1).content, /主机 B 回复/);
  assert.deepEqual(conversations["session-a"].at(-1).usage, { inputTokens: 12, outputTokens: 5 });
  store.clearSession("session-a");
  store.clearSession("session-b");
});
