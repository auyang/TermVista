import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getLanguageForFile, getRegisteredLanguageReport } from "../src/features/editor/languageRegistry.ts";

const monacoIndexPath = new URL("../node_modules/monaco-editor/esm/vs/index.js", import.meta.url);
const monacoIndex = await readFile(monacoIndexPath, "utf8");
const registeredIds = new Set(
  [...monacoIndex.matchAll(/['"]\.\/languages\/definitions\/([^/'"]+)\/register\.js['"]/g)]
    .map((match) => match[1]),
);
if (monacoIndex.includes("languages/features/json/register.js")) registeredIds.add("json");
const report = getRegisteredLanguageReport([...registeredIds].map((id) => ({ id })));

test("编辑器语言候选映射到实际随包注册的 Monaco 模式", () => {
  assert.ok(report.registeredCount >= 40, `实际注册 ${report.registeredCount} 种语言`);
  assert.deepEqual(report.missingIds, []);
});

test("语言识别使用最长后缀且只返回已注册模式", () => {
  assert.equal(getLanguageForFile("/srv/app/config.jsonc", registeredIds), "json");
  assert.equal(getLanguageForFile("/srv/app/main.tsx", registeredIds), "typescript");
  assert.equal(getLanguageForFile("/srv/app/Dockerfile", registeredIds), "dockerfile");
  assert.equal(getLanguageForFile("/srv/app/archive.unknown", registeredIds), "plaintext");
  assert.equal(getLanguageForFile("/srv/app/file.tf", new Set(["plaintext"])), "plaintext");
});
