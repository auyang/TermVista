import test from "node:test";
import assert from "node:assert/strict";
import { blockOsc52ClipboardWrites, safeExternalLinkTarget } from "../src/features/terminal/securityHandlers.ts";

test("远端 OSC 52 请求被消费，不触碰本机剪贴板", () => {
  let registeredCode;
  let handler;
  let clipboardWrites = 0;
  const subscription = blockOsc52ClipboardWrites({
    registerOscHandler(code, callback) {
      registeredCode = code;
      handler = callback;
      return { dispose() {} };
    },
  });

  assert.equal(registeredCode, 52);
  assert.equal(handler("c;YXR0YWNrZXI="), true);
  assert.equal(clipboardWrites, 0);
  assert.equal(typeof subscription.dispose, "function");
});

test("终端外链仅接受无凭据的 HTTP(S) URL", () => {
  assert.equal(safeExternalLinkTarget("https://example.com/path?q=1"), "https://example.com/path?q=1");
  assert.equal(safeExternalLinkTarget("http://example.com"), "http://example.com/");
  assert.equal(safeExternalLinkTarget("javascript:alert(1)"), null);
  assert.equal(safeExternalLinkTarget("file:///etc/passwd"), null);
  assert.equal(safeExternalLinkTarget("https://user:secret@example.com"), null);
  assert.equal(safeExternalLinkTarget("not a URL"), null);
});
