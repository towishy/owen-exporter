import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import esbuild from "esbuild";

const sourcePath = fileURLToPath(new URL("../main.ts", import.meta.url));
const { outputFiles } = await esbuild.build({
  stdin: {
    contents: readFileSync(sourcePath, "utf8") + "\nexport { OwenExporterSettingTab, DEFAULT_SETTINGS };",
    resolveDir: dirname(sourcePath),
    sourcefile: sourcePath,
    loader: "ts",
  },
  bundle: true,
  external: ["obsidian", "electron"],
  platform: "node",
  format: "cjs",
  write: false,
});

function createHost(modern) {
  let mutations = 0;
  const controls = new Map();
  class Element {
    classList = { add() {}, contains() { return false; } };
    closest() { return null; }
    querySelector() { return null; }
    constructor(parentElement) { this.parentElement = parentElement; }
    addClass() { mutations += 1; }
    empty() { mutations += 1; }
    createDiv() { mutations += 1; return new Element(this); }
    setAttr() { mutations += 1; }
    insertBefore() { mutations += 1; }
    dataset = {};
  }
  const container = new Element();
  class Setting {
    constructor(parent) {
      this.settingEl = parent.createDiv();
      this.infoEl = this.settingEl.createDiv();
      this.nameEl = this.infoEl.createDiv();
      this.descEl = this.infoEl.createDiv();
      this.controlEl = this.settingEl.createDiv();
    }
    setName(name) { this.name = name; return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addControl(configure) {
      const control = {
        sliderEl: new Element(),
        addOption() { return this; },
        setValue(value) { this.value = value; return this; },
        setLimits() { return this; },
        setPlaceholder() { return this; },
        setButtonText() { return this; },
        setIcon() { return this; },
        onChange(callback) { this.change = callback; return this; },
        onClick(callback) { this.click = callback; return this; },
      };
      configure(control);
      controls.set(this.name, control);
      return this;
    }
    addDropdown(configure) { return this.addControl(configure); }
    addToggle(configure) { return this.addControl(configure); }
    addSlider(configure) { return this.addControl(configure); }
    addText(configure) { return this.addControl(configure); }
    addTextArea(configure) { return this.addControl(configure); }
    addButton(configure) { return this.addControl(configure); }
  }
  class PluginSettingTab {
    containerEl = container;
    constructor() {
      if (modern) this.update = () => { this.settingItems = this.getSettingDefinitions(); };
    }
  }
  const module = { exports: {} };
  new Function("module", "exports", "require", outputFiles[0].text)(module, module.exports, (name) => {
    if (name === "electron") return { shell: {}, remote: undefined };
    if (name === "fs/promises") return { writeFile() { assert.fail("Settings must not write external files."); } };
    assert.equal(name, "obsidian");
    return {
      Plugin: class {},
      Modal: class {},
      PluginSettingTab,
      Setting,
      requireApiVersion: () => modern,
      setIcon() {},
      setTooltip() {},
    };
  });
  const plugin = {
    settings: { ...module.exports.DEFAULT_SETTINGS, htmlCustomProfiles: [] },
    t: (key) => key,
    saves: 0,
    commandRefreshes: 0,
    async saveSettings() { this.saves += 1; },
    refreshCommandNames() { this.commandRefreshes += 1; },
  };
  const tab = new module.exports.OwenExporterSettingTab({}, plugin);
  return { tab, plugin, container, Setting, controls, mutations: () => mutations };
}

test("indexes individual Exporter settings in five groups without creating controls or writing files", () => {
  const { tab, mutations } = createHost(true);
  const definitions = tab.getSettingDefinitions();
  assert.equal(definitions.length, 5);
  const names = new Set(definitions.flatMap((group) => group.items.map((item) => item.name)));
  for (const key of [
    "language.name", "settings.imageFormat.name", "settings.imageSave.name", "settings.imageFolder.name",
    "settings.batchReport.name", "settings.imageFilename.name", "settings.imageQuality.name", "settings.imageScale.name",
    "settings.imageBackground.name", "settings.htmlProfile.name", "settings.htmlFolder.name", "settings.htmlFilename.name",
    "settings.htmlSave.name", "settings.htmlStyle.name", "settings.clipboard.name", "settings.documentTitle.name",
    "settings.frontmatter.name", "settings.headingIds.name", "settings.callouts.name", "settings.internalLinks.name",
    "settings.assets.name", "settings.assetFolder.name", "settings.documentTemplate.name", "settings.quickProfile.name",
    "settings.manifest.name", "settings.saveProfile.name", "settings.openAfter.name", "settings.revealAfter.name",
    "settings.copyAfter.name", "settings.insertLink.name", "settings.backup.name",
  ]) assert.equal(names.has(key), true, `Missing searchable setting: ${key}`);
  assert.equal(mutations(), 0);
});

test("legacy settings controls persist image and locale choices without requiring the new host API", async () => {
  const { tab, plugin, controls } = createHost(false);
  assert.equal(tab.update, undefined);
  tab.display();
  await controls.get("settings.imageFormat.name").change("jpeg");
  assert.equal(plugin.settings.imageFormat, "jpeg");
  await controls.get("language.name").change("ko");
  assert.equal(plugin.settings.language, "ko");
  assert.equal(plugin.commandRefreshes, 1);
  assert.equal(plugin.saves, 2);
});

test("changing a native HTML profile updates settings and refreshes their search definitions", async () => {
  const { tab, plugin, controls, container, Setting } = createHost(true);
  const profile = tab.getSettingDefinitions().flatMap((group) => group.items).find((item) => item.name === "settings.htmlProfile.name");
  profile.render(new Setting(container.createDiv()).setName(profile.name));
  await controls.get(profile.name).change("clean-fragment");
  assert.equal(plugin.settings.htmlExportProfile, "clean-fragment");
  assert.equal(plugin.settings.htmlStyleMode, "clean");
  assert.equal(plugin.saves, 1);
  assert.equal(tab.settingItems.length, 5);
});

test("custom profile actions enter and leave the search index with the saved collection", () => {
  const { tab, plugin, mutations } = createHost(true);
  const hasAction = () => tab.getSettingDefinitions().flatMap((group) => group.items).some((item) => item.name === "settings.applyProfile.name");
  assert.equal(hasAction(), false);
  plugin.settings.htmlCustomProfiles.push({ name: "Report", settings: {} });
  assert.equal(hasAction(), true);
  plugin.settings.htmlCustomProfiles.length = 0;
  assert.equal(hasAction(), false);
  assert.equal(mutations(), 0);
});
