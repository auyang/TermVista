import test from "node:test";
import assert from "node:assert/strict";
import { findReusableProfileTab } from "../src/features/home/profileTabReuse.ts";

test("恢复后的待重连标签优先复用，避免创建重复主机标签", () => {
  const tabs = [
    { id: "blank", mode: "blank" },
    { id: "restored", mode: "ssh", profileId: "profile-a" },
  ];

  assert.equal(findReusableProfileTab(tabs, {}, "profile-a")?.id, "restored");
});

test("已连接或连接中的同主机标签优先于待重连标签", () => {
  const tabs = [
    { id: "restored", mode: "ssh", profileId: "profile-a" },
    { id: "connected", mode: "ssh", profileId: "profile-a" },
    { id: "connecting", mode: "ssh", profileId: "profile-a" },
  ];
  const sessions = {
    connected: { state: "connected", sessionId: "ssh-session-1" },
    connecting: { state: "authenticating" },
  };

  assert.equal(findReusableProfileTab(tabs, sessions, "profile-a")?.id, "connected");
});

test("隔离其他主机标签，优先复用同主机正在连接标签", () => {
  const tabs = [
    { id: "other", mode: "ssh", profileId: "profile-b" },
    { id: "retry", mode: "ssh", profileId: "profile-a" },
  ];
  const sessions = { retry: { state: "verifyingHostKey" } };

  assert.equal(findReusableProfileTab(tabs, sessions, "profile-a")?.id, "retry");
});
