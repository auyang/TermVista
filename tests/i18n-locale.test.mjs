import test from "node:test";
import assert from "node:assert/strict";
import { detectSystemLocale, locales, matchLocale, resolveLocale } from "../src/i18n/locale.ts";

test("only the four supported locale codes are exposed", () => {
  assert.deepEqual(locales, ["en-US", "zh-CN", "ja-JP", "zh-TW"]);
});

test("system locale mapping distinguishes Simplified and Traditional Chinese", () => {
  for (const locale of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-HK"]) {
    assert.equal(matchLocale(locale), "zh-TW", locale);
  }
  for (const locale of ["zh-CN", "zh-SG", "zh-Hans", "zh-Hans-SG"]) {
    assert.equal(matchLocale(locale), "zh-CN", locale);
  }
});

test("English and Japanese regional tags map to their application locale", () => {
  assert.equal(matchLocale("en"), "en-US");
  assert.equal(matchLocale("en-GB"), "en-US");
  assert.equal(matchLocale("ja"), "ja-JP");
  assert.equal(matchLocale("ja-JP"), "ja-JP");
});

test("unknown system languages fall back to English", () => {
  assert.equal(matchLocale("fr-FR"), null);
  assert.equal(detectSystemLocale(["fr-FR"]), "en-US");
  assert.equal(detectSystemLocale(["fr-FR", "ja-JP"]), "ja-JP");
  assert.equal(detectSystemLocale([]), "en-US");
});

test("system is the only preference that follows the detected locale", () => {
  assert.equal(resolveLocale("system", ["zh-Hant-TW"]), "zh-TW");
  assert.equal(resolveLocale("en-US", ["ja-JP"]), "en-US");
});
