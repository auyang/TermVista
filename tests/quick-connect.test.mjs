import test from "node:test";
import assert from "node:assert/strict";
import { selectQuickConnectProfiles } from "../src/features/home/quickConnect.ts";

function profile(index, overrides = {}) {
  return {
    id: `profile-${index}`,
    name: `Server ${String(index).padStart(3, "0")}`,
    host: `192.0.2.${index + 1}`,
    port: 22,
    username: index % 2 ? "deploy" : "root",
    group: "test",
    authMethod: "privateKey",
    privateKeyPath: "/tmp/test-key",
    environment: "test",
    favorite: false,
    autoReconnect: false,
    credentialAccounts: [],
    ...overrides,
  };
}

test("100 台连接可搜索并按收藏、最近使用和名称排序", () => {
  const profiles = Array.from({ length: 100 }, (_, index) => profile(index, {
    favorite: index === 20 || index === 10,
    lastConnectedAt: index === 10 ? 100 : index === 20 ? 200 : index === 50 ? 300 : undefined,
  }));
  const originalOrder = profiles.map(({ id }) => id);

  const all = selectQuickConnectProfiles(profiles, "all", "");
  assert.equal(all.length, 100);
  assert.deepEqual(all.slice(0, 2).map(({ id }) => id), ["profile-20", "profile-10"]);
  assert.equal(all[2].id, "profile-50");
  assert.deepEqual(profiles.map(({ id }) => id), originalOrder, "筛选排序不修改仓库数组");

  const byHost = selectQuickConnectProfiles(profiles, "all", "192.0.2.42");
  assert.deepEqual(byHost.map(({ id }) => id), ["profile-41"]);
  const byUser = selectQuickConnectProfiles(profiles, "favorite", "SERVER 020");
  assert.deepEqual(byUser.map(({ id }) => id), ["profile-20"]);
  assert.deepEqual(selectQuickConnectProfiles(profiles, "recent", "").map(({ id }) => id), ["profile-20", "profile-10", "profile-50"]);
});
