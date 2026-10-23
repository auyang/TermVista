import assert from "node:assert/strict";
import test from "node:test";
import { profileDropInsertionIndex } from "../src/features/connections/profileTree.ts";

test("同组拖动到目标之前会计算删除拖动项后的插入位置", () => {
  const profiles = [
    { id: "a", name: "A", groupId: "group", sortOrder: 0 },
    { id: "b", name: "B", groupId: "group", sortOrder: 1 },
    { id: "c", name: "C", groupId: "group", sortOrder: 2 },
  ];

  assert.equal(profileDropInsertionIndex(profiles, "a", "c"), 1);
});

test("根层 groupId 的 null 与 undefined 等价", () => {
  const profiles = [
    { id: "root-a", name: "A", groupId: null, sortOrder: 0 },
    { id: "root-b", name: "B", sortOrder: 1 },
    { id: "root-c", name: "C", groupId: null, sortOrder: 2 },
  ];

  assert.equal(profileDropInsertionIndex(profiles, "root-a", "root-c"), 1);
});

test("跨组拖动时按目标组顺序插入，忽略自身拖动和失效目标", () => {
  const profiles = [
    { id: "source", name: "Source", groupId: "one", sortOrder: 0 },
    { id: "target-a", name: "Target A", groupId: "two", sortOrder: 0 },
    { id: "target-b", name: "Target B", groupId: "two", sortOrder: 1 },
  ];

  assert.equal(profileDropInsertionIndex(profiles, "source", "target-b"), 1);
  assert.equal(profileDropInsertionIndex(profiles, "source", "source"), null);
  assert.equal(profileDropInsertionIndex(profiles, "source", "missing"), null);
  assert.equal(profileDropInsertionIndex(profiles, "missing", "target-a"), null);
});
