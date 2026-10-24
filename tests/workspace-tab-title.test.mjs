import test from "node:test";
import assert from "node:assert/strict";
import { getWorkspaceTabDisplayTitle } from "../src/features/workspace/tabTitle.ts";

test("blank tab title follows the active UI locale, including legacy persisted tabs", () => {
  const persistedTab = { id: "blank-1", title: "新标签页", mode: "blank" };
  assert.equal(getWorkspaceTabDisplayTitle(persistedTab, "New tab"), "New tab");
  assert.equal(getWorkspaceTabDisplayTitle(persistedTab, "新标签页"), "新标签页");
  assert.equal(getWorkspaceTabDisplayTitle(persistedTab, "新しいタブ"), "新しいタブ");
  assert.equal(getWorkspaceTabDisplayTitle(persistedTab, "新分頁"), "新分頁");
});

test("named connection tabs keep their server-provided names", () => {
  assert.equal(
    getWorkspaceTabDisplayTitle({ id: "ssh-1", title: "production", mode: "ssh" }, "New tab"),
    "production",
  );
});
