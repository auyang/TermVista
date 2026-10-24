import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const languages=["en-US","zh-CN","ja-JP","zh-TW"];

test("seed resource parity and interpolation checks pass", () => {
  const result=spawnSync(process.execPath,["scripts/ci/check-i18n.mjs"],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

test("four language names and safety strings exist", () => {
  for(const locale of languages){
    const settings=JSON.parse(readFileSync(`src/i18n/locales/${locale}/settings.json`,"utf8"));
    const connect=JSON.parse(readFileSync(`src/i18n/locales/${locale}/connections.json`,"utf8"));
    const ai=JSON.parse(readFileSync(`src/i18n/locales/${locale}/ai.json`,"utf8"));
    const update=JSON.parse(readFileSync(`src/i18n/locales/${locale}/updater.json`,"utf8"));
    assert.ok(settings.interfaceLanguage && settings.systemLanguage && settings.saveFailed);
    assert.ok(connect.hostKeyChanged && ai.neverRun && update.unsafeSignature);
  }
});

test("Japanese settings contain no exact English fallback strings", () => {
  const english = JSON.parse(readFileSync("src/i18n/locales/en-US/settings.json", "utf8"));
  const japanese = JSON.parse(readFileSync("src/i18n/locales/ja-JP/settings.json", "utf8"));
  const unchanged = [];
  const compare = (source, target, path = "") => {
    for (const [key, value] of Object.entries(source)) {
      const currentPath = path ? `${path}.${key}` : key;
      const translated = target[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        compare(value, translated, currentPath);
      } else if (typeof value === "string" && value === translated) {
        unchanged.push(currentPath);
      }
    }
  };
  compare(english, japanese);
  assert.deepEqual(unchanged, [], `英語のまま残っている設定文言: ${unchanged.join(", ")}`);
});
