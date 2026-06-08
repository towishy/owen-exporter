import assert from "node:assert/strict";
import test from "node:test";

const coreModuleUrl = process.env.OWEN_EXPORTER_CORE_MODULE;
if (!coreModuleUrl) {
  throw new Error("OWEN_EXPORTER_CORE_MODULE is required");
}

const {
  getSvgDimensionsFromText,
  nextAvailableVaultPath,
  normalizeVaultFolder,
  parseSvgLength,
  renderFilenameTemplate,
  slugifyExportName,
} = await import(coreModuleUrl);

test("slugifyExportName keeps readable Korean and safe ASCII", () => {
  assert.equal(slugifyExportName("  Owen Exporter 샘플.svg  "), "owen-exporter-샘플.svg");
  assert.equal(slugifyExportName("***"), "export");
});

test("renderFilenameTemplate replaces tokens and slugifies the final name", () => {
  assert.equal(
    renderFilenameTemplate("{{rawName}} @ {{scale}}x {{date}}", { rawName: "My Diagram", scale: 2, date: "2026-06-08" }, "fallback"),
    "my-diagram-2x-2026-06-08",
  );
  assert.equal(
    renderFilenameTemplate("{{folder}}-{{note}}-{{index}}-{{heading}}", { folder: "daily", note: "plan", index: 3, heading: "Next Steps" }, "fallback"),
    "daily-plan-3-next-steps",
  );
  assert.equal(renderFilenameTemplate("", { name: "note" }, "fallback"), "note");
});

test("nextAvailableVaultPath increments existing names", async () => {
  const existing = new Set(["exports/html/note.html", "exports/html/note-2.html"]);
  const path = await nextAvailableVaultPath("/exports/html/", "note.html", (candidate) => existing.has(candidate));
  assert.equal(path, "exports/html/note-3.html");
});

test("normalizeVaultFolder trims slashes and normalizes separators", () => {
  assert.equal(normalizeVaultFolder("/exports\\images/"), "exports/images");
});

test("parseSvgLength accepts positive numeric lengths only", () => {
  assert.equal(parseSvgLength("24px"), 24);
  assert.equal(parseSvgLength("0"), null);
  assert.equal(parseSvgLength("none"), null);
});

test("getSvgDimensionsFromText prefers width and height, then viewBox, then fallback", () => {
  assert.deepEqual(getSvgDimensionsFromText('<svg width="320" height="180"></svg>'), { width: 320, height: 180 });
  assert.deepEqual(getSvgDimensionsFromText('<svg viewBox="0 0 640 360"></svg>'), { width: 640, height: 360 });
  assert.deepEqual(getSvgDimensionsFromText("not svg"), { width: 1000, height: 1000 });
});
