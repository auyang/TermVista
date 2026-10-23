import assert from "node:assert/strict";
import test from "node:test";
import { canReconnectFromTerminalEnter, isRetryableNetworkError, MAX_AUTO_RECONNECT_ATTEMPTS, reconnectDelayMs } from "../src/features/ssh/reconnectPolicy.ts";

test("重连基础退避有界递增并封顶 30 秒", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((attempt) => reconnectDelayMs(attempt, () => 0.5)), [2000, 4000, 8000, 16000, 30000, 30000]);
});

test("每次重连时序的抖动保持在基础值的正负 20%", () => {
  assert.equal(reconnectDelayMs(1, () => 0), 1600);
  assert.equal(reconnectDelayMs(1, () => 1), 2400);
  assert.equal(reconnectDelayMs(5, () => 0), 24000);
  assert.equal(reconnectDelayMs(5, () => 1), 36000);
});

test("自动重连最多五次，且认证、信任异常及手动断开不进入重试", () => {
  assert.equal(MAX_AUTO_RECONNECT_ATTEMPTS, 5);
  for (const code of ["connectionTimeout", "connectionRefused", "connectionFailed", "dnsResolutionFailed", "serverClosed"]) {
    assert.equal(isRetryableNetworkError(code), true, `${code} 应允许有限重试`);
  }
  for (const code of ["authFailed", "privateKeyInvalid", "credentialStoreUnavailable", "hostKeyMismatch", "userDisconnected", "unknown"]) {
    assert.equal(isRetryableNetworkError(code), false, `${code} 必须停止自动重连`);
  }
  assert.equal(isRetryableNetworkError(), false);
});

test("终端 Enter 仅对断线或可恢复网络错误重连", () => {
  assert.equal(canReconnectFromTerminalEnter("disconnected", "serverClosed"), true);
  assert.equal(canReconnectFromTerminalEnter("error", "connectionTimeout"), true);
  for (const code of ["hostKeyMismatch", "authFailed", "credentialStoreUnavailable", "userDisconnected"]) {
    assert.equal(canReconnectFromTerminalEnter("disconnected", code), false);
    assert.equal(canReconnectFromTerminalEnter("error", code), false);
  }
  assert.equal(canReconnectFromTerminalEnter("connected"), false);
});
