import test from "node:test";
import assert from "node:assert/strict";
import { updaterErrorCode } from "../src/features/updater/updaterErrors.ts";

test("update plugin errors map to stable UI codes", () => {
  assert.equal(updaterErrorCode(new Error("HTTP 404")), "notFound");
  assert.equal(updaterErrorCode(new Error("HTTP 403")), "forbidden");
  assert.equal(updaterErrorCode(new Error("signature verification failed")), "signature");
  assert.equal(updaterErrorCode(new Error("network timeout")), "network");
  assert.equal(updaterErrorCode(new Error("unexpected plugin failure")), "unknown");
  assert.equal(updaterErrorCode(new Error("签名验证错误")), "unknown");
});
