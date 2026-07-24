import assert from "node:assert/strict";
import test from "node:test";

const i18nModuleUrl = process.env.OWEN_EXPORTER_I18N_MODULE;
if (!i18nModuleUrl) {
  throw new Error("OWEN_EXPORTER_I18N_MODULE is required");
}

const {
  EN_TRANSLATIONS,
  KO_TRANSLATIONS,
  normalizeLocale,
  normalizeLocalePreference,
  resolveLocale,
  translate,
} = await import(i18nModuleUrl);

test("English and Korean translation catalogs have identical keys", () => {
  assert.deepEqual(Object.keys(KO_TRANSLATIONS).sort(), Object.keys(EN_TRANSLATIONS).sort());
});

test("translate falls back to English content for inherited Korean entries", () => {
  assert.equal(translate("ko", "common.transparent"), "투명");
  assert.equal(translate("en", "common.transparent"), "transparent");
});

test("translate interpolates known variables and preserves missing placeholders", () => {
  assert.equal(translate("ko", "notice.savedHtml", { path: "exports/note.html" }), "HTML 내보내기를 저장했습니다: exports/note.html");
  assert.equal(translate("en", "notice.savedHtml"), "Saved HTML export: {{path}}");
});

test("normalizeLocale accepts Korean variants and defaults unsupported values to English", () => {
  assert.equal(normalizeLocale("ko"), "ko");
  assert.equal(normalizeLocale("KO_kr"), "ko");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("ja"), "en");
  assert.equal(normalizeLocale(undefined), "en");
});

test("automatic locale follows Korean Obsidian and explicit overrides win", () => {
  assert.equal(normalizeLocalePreference(undefined), "auto");
  assert.equal(resolveLocale("auto", "ko-KR"), "ko");
  assert.equal(resolveLocale("auto", "ja"), "en");
  assert.equal(resolveLocale("en", "ko"), "en");
  assert.equal(resolveLocale("ko", "en"), "ko");
});