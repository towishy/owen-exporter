import { remote, shell } from "electron";
import { writeFile } from "fs/promises";
import {
    App,
    Component,
    Editor,
    FileSystemAdapter,
    MarkdownRenderer,
    MarkdownView,
    Menu,
    Modal,
    Notice,
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    moment,
    normalizePath,
    requestUrl,
    sanitizeHTMLToDom,
    setIcon,
} from "obsidian";
import {
    SvgDimensions,
    getSvgDimensionsFromText,
    nextAvailableVaultPath,
    normalizeVaultFolder,
    renderFilenameTemplate,
    slugifyExportName,
} from "./core";
import { Locale, LocalePreference, TranslationKey, TranslationVars, normalizeLocalePreference, resolveLocale, translate } from "./i18n";

  type Translator = (key: TranslationKey, vars?: TranslationVars) => string;

type ExportImageFormat = "png" | "jpeg";
type ImageSaveMode = "dialog" | "vault";
type HtmlSaveMode = "fragment" | "document";
type HtmlStyleMode = "obsidian" | "portable" | "clean";
type HtmlClipboardMode = "html-and-text" | "html" | "text";
type HtmlExportProfile = "custom" | "obsidian-document" | "portable-document" | "clean-fragment";
type SvgBatchReportMode = "never" | "on-failure" | "always";
type RecentExportKind = "html-copy" | "html-save" | "image-save" | "report";
type HtmlAssetMode = "keep" | "relative" | "copy" | "base64";
type ExportJobStatus = "pending" | "running" | "success" | "failed" | "skipped";
type DomConstructorWindow = Window & {
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  HTMLImageElement: typeof HTMLImageElement;
  SVGSVGElement: typeof SVGSVGElement;
};

interface OwenExporterSettings {
  language: LocalePreference;
  imageFormat: ExportImageFormat;
  imageSaveMode: ImageSaveMode;
  imageQuality: number;
  imageScale: number;
  imageBackground: string;
  imageOutputFolder: string;
  imageFilenameTemplate: string;
  htmlOutputFolder: string;
  htmlFilenameTemplate: string;
  htmlExportProfile: HtmlExportProfile;
  htmlSaveMode: HtmlSaveMode;
  htmlStyleMode: HtmlStyleMode;
  htmlClipboardMode: HtmlClipboardMode;
  htmlDocumentTitle: string;
  svgBatchReportMode: SvgBatchReportMode;
  htmlCustomProfiles: HtmlCustomProfile[];
  htmlExcludeFrontmatter: boolean;
  htmlPreserveHeadingIds: boolean;
  htmlPreserveCalloutClasses: boolean;
  htmlConvertInternalLinksToObsidianUris: boolean;
  htmlAssetMode: HtmlAssetMode;
  htmlAssetOutputFolder: string;
  htmlDocumentTemplate: string;
  writeExportManifest: boolean;
  afterExportOpenFile: boolean;
  afterExportRevealFile: boolean;
  afterExportCopyPath: boolean;
  afterImageExportInsertMarkdownLink: boolean;
}

interface HtmlCustomProfile {
  name: string;
  htmlOutputFolder: string;
  htmlFilenameTemplate: string;
  htmlSaveMode: HtmlSaveMode;
  htmlStyleMode: HtmlStyleMode;
  htmlClipboardMode: HtmlClipboardMode;
  htmlDocumentTitle: string;
  htmlExcludeFrontmatter: boolean;
  htmlPreserveHeadingIds: boolean;
  htmlPreserveCalloutClasses: boolean;
  htmlConvertInternalLinksToObsidianUris: boolean;
  htmlAssetMode: HtmlAssetMode;
  htmlAssetOutputFolder: string;
  htmlDocumentTemplate: string;
}

interface FilenameTokenOptions {
  sourcePath?: string | null;
  index?: number;
  heading?: string | null;
}

interface SavedFileResult {
  filename: string;
  vaultPath?: string;
  systemPath?: string;
}

type LastExportAction =
  | { type: "html-copy"; html: string; sourcePath: string | null; fallbackName: string; label: string }
  | { type: "html-save"; html: string; sourcePath: string | null; fallbackName: string; label: string }
  | { type: "svg"; svgText: string; baseName: string; format: ExportImageFormat; options: FilenameTokenOptions; label: string };

interface LastExportResult {
  filename: string;
  vaultPath?: string;
  systemPath?: string;
}

interface RecentExportEntry extends LastExportResult {
  id: string;
  kind: RecentExportKind;
  label: string;
  createdAt: string;
}

interface SvgBatchResult {
  index: number;
  sourcePath: string;
  outputPath?: string;
  error?: string;
}

interface ExportManifestEntry {
  sourcePath: string;
  outputPath?: string;
  status: "success" | "failed" | "skipped";
  error?: string;
  sourceMtime?: number;
  profile: string;
  styleMode: HtmlStyleMode;
  saveMode: HtmlSaveMode;
  createdAt: string;
}

interface ExportManifest {
  version: 1;
  pluginVersion: string;
  createdAt: string;
  label: string;
  entries: ExportManifestEntry[];
}

interface ExportJobEntry {
  label: string;
  status: ExportJobStatus;
  detail?: string;
}

interface HtmlPreviewOptions {
  title: string;
  html: string;
  onCopy: () => Promise<void>;
  onSave: () => Promise<void>;
}

interface SvgPreviewOptions {
  baseName: string;
  format: ExportImageFormat;
  sourcePath: string | null;
  svgText: string;
  dimensions: SvgDimensions;
  warnings: string[];
  filename: string;
  outputWidth: number;
  outputHeight: number;
  background: string;
  onExport: (format: ExportImageFormat) => Promise<void>;
}

interface ExporterSettingsFile {
  version: number;
  settings: Partial<OwenExporterSettings>;
}

interface ExportHistoryActions {
  open(entry: RecentExportEntry): Promise<void>;
  reveal(entry: RecentExportEntry): Promise<void>;
  copyPath(entry: RecentExportEntry): Promise<void>;
  clear(): void;
}

interface ExportJobController {
  modal: ExportJobModal;
  cancelled: boolean;
}

interface ValidationIssue {
  severity: "warning" | "error";
  sourcePath: string;
  message: string;
}

interface NoteExportMetadata {
  profile?: string;
  filename?: string;
  style?: HtmlStyleMode;
  saveMode?: HtmlSaveMode;
  title?: string;
  assetMode?: HtmlAssetMode;
}

interface SvgTarget {
  element: HTMLImageElement;
  sourcePath: string | null;
  suggestedName: string;
}

interface MarkdownSourceInfo {
  file?: TFile | null;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface FileSystemWritableFileStream {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface WindowWithSavePicker extends Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
}

const DEFAULT_SETTINGS: OwenExporterSettings = {
  language: "auto",
  imageFormat: "png",
  imageSaveMode: "dialog",
  imageQuality: 0.92,
  imageScale: 2,
  imageBackground: "#FFFFFF",
  imageOutputFolder: "exports/images",
  imageFilenameTemplate: "{{name}}",
  htmlOutputFolder: "exports/html",
  htmlFilenameTemplate: "{{name}}",
  htmlExportProfile: "obsidian-document",
  htmlSaveMode: "document",
  htmlStyleMode: "obsidian",
  htmlClipboardMode: "html-and-text",
  htmlDocumentTitle: "{{name}} export",
  svgBatchReportMode: "on-failure",
  htmlCustomProfiles: [],
  htmlExcludeFrontmatter: true,
  htmlPreserveHeadingIds: true,
  htmlPreserveCalloutClasses: true,
  htmlConvertInternalLinksToObsidianUris: false,
  htmlAssetMode: "keep",
  htmlAssetOutputFolder: "exports/html/assets",
  htmlDocumentTemplate: "",
  writeExportManifest: true,
  afterExportOpenFile: false,
  afterExportRevealFile: false,
  afterExportCopyPath: false,
  afterImageExportInsertMarkdownLink: false,
};

const MAX_RECENT_EXPORTS = 10;

const HTML_EXPORT_PROFILES: Record<Exclude<HtmlExportProfile, "custom">, Pick<OwenExporterSettings, "htmlSaveMode" | "htmlStyleMode" | "htmlDocumentTitle">> = {
  "obsidian-document": {
    htmlSaveMode: "document",
    htmlStyleMode: "obsidian",
    htmlDocumentTitle: "{{name}} export",
  },
  "portable-document": {
    htmlSaveMode: "document",
    htmlStyleMode: "portable",
    htmlDocumentTitle: "{{rawName}} export",
  },
  "clean-fragment": {
    htmlSaveMode: "fragment",
    htmlStyleMode: "clean",
    htmlDocumentTitle: "{{rawName}}",
  },
};

const MAX_CANVAS_PIXELS = 100_000_000;

const HTML_STYLE_SELECTOR = [
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "pre",
  "code",
  "blockquote",
  "p",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  ".callout",
  ".callout-title",
  ".callout-title-inner",
  ".callout-content",
  ".callout-icon",
].join(", ");

const HTML_STYLE_PROPERTIES = [
  "background-color",
  "align-items",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-collapse",
  "border-spacing",
  "border-radius",
  "box-shadow",
  "box-sizing",
  "color",
  "display",
  "flex",
  "flex-direction",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "gap",
  "height",
  "justify-content",
  "line-height",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "max-width",
  "min-width",
  "opacity",
  "overflow",
  "overflow-x",
  "overflow-y",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "text-align",
  "text-decoration",
  "tab-size",
  "vertical-align",
  "white-space",
  "width",
  "word-break",
  "word-wrap",
];

const HTML_PORTABLE_STYLE_PROPERTIES = [
  "background-color",
  "border",
  "border-collapse",
  "border-radius",
  "box-sizing",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "text-align",
  "text-decoration",
  "vertical-align",
  "white-space",
  "word-break",
  "word-wrap",
];

const HTML_STYLE_VARIABLES = [
  "--callout-color",
  "--callout-icon",
  "--code-background",
  "--code-normal",
  "--table-border-color",
  "--table-header-background",
  "--table-header-color",
  "--table-row-alt-background",
  "--text-normal",
  "--text-muted",
];

export default class OwenExporterPlugin extends Plugin {
  settings: OwenExporterSettings;

  get locale(): Locale {
    return resolveLocale(this.settings.language, moment.locale());
  }
  private lastExportAction: LastExportAction | null = null;
  private lastExportResult: LastExportResult | null = null;
  private recentExports: RecentExportEntry[] = [];

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new OwenExporterSettingTab(this.app, this));

    this.addCommand({
      id: "copy-selected-markdown-as-html",
      name: this.t("command.copySelection"),
      editorCheckCallback: (checking, editor, view) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          return false;
        }
        if (!checking) {
          void this.copySelectionAsHtml(editor, view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "preview-selected-markdown-as-html",
      name: this.t("command.previewSelection"),
      editorCheckCallback: (checking, editor, view) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          return false;
        }
        if (!checking) {
          void this.previewSelectionAsHtml(editor, view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "compare-selected-markdown-html-styles",
      name: this.t("command.compareSelection"),
      editorCheckCallback: (checking, editor, view) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          return false;
        }
        if (!checking) {
          void this.compareMarkdownHtmlStyles(selection, view.file?.path ?? "", this.t("compare.selectionTitle"));
        }
        return true;
      },
    });

    this.addCommand({
      id: "save-selected-markdown-as-html",
      name: this.t("command.saveSelection"),
      editorCheckCallback: (checking, editor, view) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          return false;
        }
        if (!checking) {
          void this.saveSelectionAsHtml(editor, view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "preview-current-note-as-html",
      name: this.t("command.previewNote"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.previewCurrentNoteAsHtml(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "compare-current-note-html-styles",
      name: this.t("command.compareNote"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.compareCurrentNoteHtmlStyles(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "save-current-note-as-html",
      name: this.t("command.saveNote"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.saveCurrentNoteAsHtml(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "export-current-folder-notes-as-html",
      name: this.t("command.exportFolder"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.exportCurrentFolderNotesAsHtml(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "export-changed-current-folder-notes-as-html",
      name: this.t("command.exportChangedFolder"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.exportChangedCurrentFolderNotesAsHtml(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "export-linked-notes-as-html",
      name: this.t("command.exportLinked"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.exportLinkedNotesAsHtml(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "export-changed-linked-notes-as-html",
      name: this.t("command.exportChangedLinked"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.exportChangedLinkedNotesAsHtml(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "validate-current-note-export",
      name: this.t("command.validateNote"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.validateCurrentNoteExport(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "export-current-note-svgs",
      name: this.t("command.exportNoteSvgs"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.exportCurrentNoteSvgs(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "diagnose-current-note-svgs",
      name: this.t("command.diagnoseNoteSvgs"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.diagnoseCurrentNoteSvgs(view);
        }
        return true;
      },
    });

    this.addCommand({
      id: "rerun-last-export",
      name: this.t("command.rerun"),
      checkCallback: (checking) => {
        if (!this.lastExportAction) {
          return false;
        }
        if (!checking) {
          void this.runLastExport();
        }
        return true;
      },
    });

    this.addCommand({
      id: "open-last-exported-file",
      name: this.t("command.openLast"),
      checkCallback: (checking) => {
        if (!this.lastExportResult) {
          return false;
        }
        if (!checking) {
          void this.openLastExportedFile();
        }
        return true;
      },
    });

    this.addCommand({
      id: "reveal-last-exported-file",
      name: this.t("command.revealLast"),
      checkCallback: (checking) => {
        if (!this.lastExportResult) {
          return false;
        }
        if (!checking) {
          void this.revealLastExportedFile();
        }
        return true;
      },
    });

    this.addCommand({
      id: "copy-last-exported-path",
      name: this.t("command.copyLastPath"),
      checkCallback: (checking) => {
        if (!this.lastExportResult) {
          return false;
        }
        if (!checking) {
          void this.copyLastExportedPath();
        }
        return true;
      },
    });

    this.addCommand({
      id: "show-export-history",
      name: this.t("command.history"),
      callback: () => this.openExportHistory(),
    });

    this.addCommand({
      id: "quick-switch-html-profile",
      name: this.t("command.switchProfile"),
      callback: () => this.openHtmlProfileSwitcher(),
    });

    this.addCommand({
      id: "export-settings-json",
      name: this.t("command.exportSettings"),
      callback: () => void this.exportSettingsJson(),
    });

    this.addCommand({
      id: "import-settings-json-from-clipboard",
      name: this.t("command.importSettings"),
      callback: () => void this.importSettingsJsonFromClipboard(),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!editor.getSelection().trim()) {
          return;
        }
        menu.addSeparator();
        menu.addItem((item) => {
          item
            .setTitle(this.t("menu.copySelection"))
            .setIcon("copy")
            .onClick(() => void this.copySelectionAsHtml(editor, view));
        });
        this.addHtmlCopyAsMenuItems(menu, async () => this.renderMarkdownToHtml(editor.getSelection(), view.file?.path ?? ""), view.file?.path ?? null, "selection");
        menu.addItem((item) => {
          item
            .setTitle(this.t("menu.previewSelection"))
            .setIcon("eye")
            .onClick(() => void this.previewSelectionAsHtml(editor, view));
        });
        menu.addItem((item) => {
          item
            .setTitle(this.t("menu.compareStyles"))
            .setIcon("columns-3")
            .onClick(() => void this.compareMarkdownHtmlStyles(editor.getSelection(), view.file?.path ?? "", this.t("compare.selectionTitle")));
        });
        menu.addItem((item) => {
          item
            .setTitle(this.t("menu.saveSelection"))
            .setIcon("file-down")
            .onClick(() => void this.saveSelectionAsHtml(editor, view));
        });
      }),
    );

    this.registerDomEvent(activeDocument, "contextmenu", (event) => {
      const svgTarget = this.findSvgTarget(event);
      if (!svgTarget) {
        this.addPreviewSelectionMenu(event);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const menu = new Menu();
      menu.addItem((item) => {
        item
          .setTitle(this.t("menu.downloadSvg", { format: this.settings.imageFormat.toUpperCase() }))
          .setIcon("image-down")
          .onClick(() => void this.exportSvgTarget(svgTarget, this.settings.imageFormat));
      });
      menu.addItem((item) => {
        const alternateFormat = this.settings.imageFormat === "png" ? "jpeg" : "png";
        item
          .setTitle(this.t("menu.downloadSvg", { format: alternateFormat.toUpperCase() }))
          .setIcon("image")
          .onClick(() => void this.exportSvgTarget(svgTarget, alternateFormat));
      });
      menu.addItem((item) => {
        item
          .setTitle(this.t("menu.previewSvg"))
          .setIcon("eye")
          .onClick(() => void this.previewSvgTarget(svgTarget));
      });
      menu.addItem((item) => {
        item
          .setTitle(this.t("menu.diagnoseSvg"))
          .setIcon("search-check")
          .onClick(() => void this.diagnoseSvgTarget(svgTarget));
      });
      menu.showAtMouseEvent(event);
    }, { capture: true });
  }

  async loadSettings() {
    const loadedSettings = await this.loadData() as Partial<OwenExporterSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loadedSettings ?? {}) };
    this.settings.language = normalizeLocalePreference(loadedSettings?.language);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  t(key: TranslationKey, vars: TranslationVars = {}): string {
    return translate(this.locale, key, vars);
  }

  refreshCommandNames(): void {
    const commandManager = (this.app as App & { commands?: { commands?: Record<string, { name: string }> } }).commands;
    const commandKeys: Record<string, TranslationKey> = {
      "copy-selected-markdown-as-html": "command.copySelection",
      "preview-selected-markdown-as-html": "command.previewSelection",
      "compare-selected-markdown-html-styles": "command.compareSelection",
      "save-selected-markdown-as-html": "command.saveSelection",
      "preview-current-note-as-html": "command.previewNote",
      "compare-current-note-html-styles": "command.compareNote",
      "save-current-note-as-html": "command.saveNote",
      "export-current-folder-notes-as-html": "command.exportFolder",
      "export-changed-current-folder-notes-as-html": "command.exportChangedFolder",
      "export-linked-notes-as-html": "command.exportLinked",
      "export-changed-linked-notes-as-html": "command.exportChangedLinked",
      "validate-current-note-export": "command.validateNote",
      "export-current-note-svgs": "command.exportNoteSvgs",
      "diagnose-current-note-svgs": "command.diagnoseNoteSvgs",
      "rerun-last-export": "command.rerun",
      "open-last-exported-file": "command.openLast",
      "reveal-last-exported-file": "command.revealLast",
      "copy-last-exported-path": "command.copyLastPath",
      "show-export-history": "command.history",
      "quick-switch-html-profile": "command.switchProfile",
      "export-settings-json": "command.exportSettings",
      "import-settings-json-from-clipboard": "command.importSettings",
    };
    for (const [id, key] of Object.entries(commandKeys)) {
      const command = commandManager?.commands?.[`${this.manifest.id}:${id}`];
      if (command) {
        command.name = this.t(key);
      }
    }
  }

  private recordLastExport(action: LastExportAction) {
    this.lastExportAction = action;
  }

  private async recordSavedFile(result: SavedFileResult, kind: RecentExportKind = "html-save", label = result.filename) {
    this.lastExportResult = {
      filename: result.filename,
      vaultPath: result.vaultPath,
      systemPath: result.systemPath,
    };
    this.recentExports.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind,
      label,
      filename: result.filename,
      vaultPath: result.vaultPath,
      systemPath: result.systemPath,
      createdAt: new Date().toISOString(),
    });
    this.recentExports = this.recentExports.slice(0, MAX_RECENT_EXPORTS);
    await this.runAfterExportActions(this.lastExportResult);
  }

  private async runAfterExportActions(result: LastExportResult) {
    const path = result.systemPath ?? result.vaultPath ?? result.filename;
    if (this.settings.afterExportCopyPath) {
      await navigator.clipboard.writeText(path);
    }
    if (this.settings.afterExportOpenFile) {
      await this.openExportedResult(result);
    }
    if (this.settings.afterExportRevealFile) {
      await this.revealExportedResult(result);
    }
  }

  private async runLastExport() {
    if (!this.lastExportAction) {
      new Notice(this.t("notice.noPrevious"));
      return;
    }

    const action = this.lastExportAction;
    try {
      if (action.type === "html-copy") {
        await this.copyHtmlExport(action.html, action.sourcePath, action.fallbackName);
      } else if (action.type === "html-save") {
        await this.saveHtmlToFile(action.html, action.sourcePath, action.fallbackName);
      } else {
        await this.exportSvgText(action.svgText, action.baseName, action.format, action.options);
      }
    } catch (error) {
      console.error(error);
      new Notice(this.t("notice.rerunFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async openLastExportedFile() {
    const result = this.lastExportResult;
    if (!result) {
      return;
    }

    await this.openExportedResult(result);
  }

  private async revealLastExportedFile() {
    const result = this.lastExportResult;
    if (!result) {
      return;
    }

    await this.revealExportedResult(result);
  }

  private async openExportedResult(result: LastExportResult) {
    if (result.vaultPath) {
      await this.app.workspace.openLinkText(result.vaultPath, "", true);
      return;
    }
    if (result.systemPath) {
      const error = await shell.openPath(result.systemPath);
      if (error) {
        new Notice(error);
      }
    }
  }

  private async revealExportedResult(result: LastExportResult) {
    const systemPath = result.systemPath ?? this.getSystemPathForVaultPath(result.vaultPath ?? "");
    if (!systemPath) {
      new Notice(this.t("notice.revealFailed"));
      return;
    }
    shell.showItemInFolder(systemPath);
  }

  private async copyLastExportedPath() {
    const result = this.lastExportResult;
    if (!result) {
      return;
    }
    const path = result.systemPath ?? result.vaultPath ?? result.filename;
    await navigator.clipboard.writeText(path);
    new Notice(this.t("notice.copiedLastPath"));
  }

  private getSystemPathForVaultPath(vaultPath: string): string | null {
    if (!vaultPath) {
      return null;
    }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return null;
    }
    return adapter.getFullPath(vaultPath);
  }

  private addPreviewSelectionMenu(event: MouseEvent) {
    const selection = activeWindow.getSelection();
    const selectedText = selection?.toString().trim();
    const target = this.isHtmlElement(event.target) ? event.target : null;
    const preview = target?.closest(".markdown-preview-view");

    if (!selection || !selectedText || !preview || !selection.rangeCount) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (!preview.contains(range.commonAncestorContainer)) {
      return;
    }

    const html = this.getSelectedHtmlFragment(range);
    if (!html.trim()) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.copySelection"))
        .setIcon("copy")
        .onClick(() => void this.copyHtmlExport(html, this.getActiveSourcePath(), "selection"));
    });
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.copyPlainText"))
        .setIcon("text")
        .onClick(() => void this.copyHtmlWithTemporaryOptions(html, this.getActiveSourcePath(), "selection", { htmlClipboardMode: "text" }));
    });
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.previewSelection"))
        .setIcon("eye")
        .onClick(() => this.openHtmlPreview(this.t("preview.selectionTitle"), html, this.getActiveSourcePath(), "selection"));
    });
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.saveSelection"))
        .setIcon("file-down")
        .onClick(() => void this.saveHtmlToFile(html, this.getActiveSourcePath(), "selection"));
    });
    menu.showAtMouseEvent(event);
  }

  private addHtmlCopyAsMenuItems(menu: Menu, renderHtml: () => Promise<string>, sourcePath: string | null, fallbackName: string) {
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.copyObsidian"))
        .setIcon("copy")
        .onClick(() => void this.copyRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlStyleMode: "obsidian", htmlClipboardMode: "html-and-text" }));
    });
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.copyPortable"))
        .setIcon("copy")
        .onClick(() => void this.copyRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlStyleMode: "portable", htmlClipboardMode: "html-and-text" }));
    });
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.copyClean"))
        .setIcon("copy")
        .onClick(() => void this.copyRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlStyleMode: "clean", htmlClipboardMode: "html" }));
    });
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.copyPlain"))
        .setIcon("text")
        .onClick(() => void this.copyRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlClipboardMode: "text" }));
    });
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.saveDocument"))
        .setIcon("file-down")
        .onClick(() => void this.saveRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlSaveMode: "document" }));
    });
    menu.addItem((item) => {
      item
        .setTitle(this.t("menu.saveFragment"))
        .setIcon("file-down")
        .onClick(() => void this.saveRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlSaveMode: "fragment" }));
    });
  }

  private async copyRenderedHtmlWithTemporaryOptions(renderHtml: () => Promise<string>, sourcePath: string | null, fallbackName: string, settings: Partial<OwenExporterSettings>) {
    await this.withTemporarySettings(settings, async () => {
      await this.copyHtmlExport(await renderHtml(), sourcePath, fallbackName);
    });
  }

  private async saveRenderedHtmlWithTemporaryOptions(renderHtml: () => Promise<string>, sourcePath: string | null, fallbackName: string, settings: Partial<OwenExporterSettings>) {
    await this.withTemporarySettings(settings, async () => {
      await this.saveHtmlToFile(await renderHtml(), sourcePath, fallbackName);
    });
  }

  private async copyHtmlWithTemporaryOptions(html: string, sourcePath: string | null, fallbackName: string, settings: Partial<OwenExporterSettings>) {
    await this.withTemporarySettings(settings, async () => {
      await this.copyHtmlExport(html, sourcePath, fallbackName);
    });
  }

  private async withTemporarySettings<T>(settings: Partial<OwenExporterSettings>, run: () => Promise<T>): Promise<T> {
    const previous = { ...this.settings };
    Object.assign(this.settings, settings);
    try {
      return await run();
    } finally {
      this.settings = previous;
    }
  }

  private async previewSvgTarget(target: SvgTarget) {
    try {
      const svgText = this.ensureSvgNamespace(await this.getSvgText(target));
      const baseName = target.suggestedName.replace(/\.svg$/i, "");
      this.openSvgPreview(svgText, baseName, target.sourcePath, this.settings.imageFormat);
    } catch (error) {
      console.error(error);
      new Notice(this.t("notice.previewSvgFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }

  private openSvgPreview(svgText: string, baseName: string, sourcePath: string | null, format: ExportImageFormat) {
    const dimensions = getSvgDimensionsFromText(svgText);
    const scale = this.getImageScale();
    const outputWidth = Math.max(1, Math.round(dimensions.width * scale));
    const outputHeight = Math.max(1, Math.round(dimensions.height * scale));
    const extension = format === "jpeg" ? "jpg" : "png";
    const filename = this.buildImageFilename(baseName, format, extension, { sourcePath, heading: baseName });
    new SvgPreviewModal(this.app, this.t.bind(this), {
      baseName,
      format,
      sourcePath,
      svgText,
      dimensions,
      warnings: this.getSvgExportWarnings(svgText, format),
      filename,
      outputWidth,
      outputHeight,
      background: this.settings.imageBackground,
      onExport: (nextFormat) => this.exportSvgText(svgText, baseName, nextFormat, { sourcePath, heading: baseName }),
    }).open();
  }

  private insertMarkdownLinkForExport(vaultPath: string) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }
    view.editor.replaceSelection(`![[${vaultPath}]]`);
  }

  private findSvgTarget(event: MouseEvent): SvgTarget | null {
    for (const element of this.getContextPathElements(event)) {
      if (!this.isInsideMarkdownContent(element)) {
        continue;
      }

      const image = this.findClosestOrChildImage(element);
      if (image && this.isSvgImage(image)) {
        return {
          element: image,
          sourcePath: this.getImageVaultPath(image),
          suggestedName: this.getSuggestedImageName(image),
        };
      }
    }

    return null;
  }

  private getContextPathElements(event: MouseEvent): Element[] {
    const path = event.composedPath();
    const elements = path.filter((target): target is Element => this.isElement(target));
    if (this.isElement(event.target) && !elements.includes(event.target)) {
      elements.unshift(event.target);
    }
    return elements;
  }

  private findClosestOrChildImage(element: Element): HTMLImageElement | null {
    if (this.isImageElement(element)) {
      return element;
    }
    const closest = element.closest("img");
    if (this.isImageElement(closest)) {
      return closest;
    }
    if (!this.isLikelyImageEmbed(element)) {
      return null;
    }
    return element.querySelector("img");
  }

  private isLikelyImageEmbed(element: Element): boolean {
    return element.matches(".image-embed, .media-embed, .internal-embed, .external-embed, [src$='.svg'], [alt$='.svg']");
  }

  private isInsideMarkdownContent(element: Element): boolean {
    return Boolean(element.closest(".markdown-preview-view, .markdown-source-view, .markdown-rendered"));
  }

  private isElement(value: unknown): value is Element {
    return this.isDomNode(value) && value.instanceOf(this.getActiveDomWindow().Element);
  }

  private isHtmlElement(value: unknown): value is HTMLElement {
    return this.isDomNode(value) && value.instanceOf(this.getActiveDomWindow().HTMLElement);
  }

  private isDomNode(value: unknown): value is Node {
    return Boolean(value && typeof value === "object" && typeof (value as { instanceOf?: unknown }).instanceOf === "function");
  }

  private isImageElement(value: Element | null): value is HTMLImageElement {
    if (!value) {
      return false;
    }
    const ownerWindow = this.getOwnerDomWindow(value);
    return value.instanceOf(ownerWindow.HTMLImageElement);
  }

  private getActiveDomWindow(): DomConstructorWindow {
    return activeWindow as DomConstructorWindow;
  }

  private getOwnerDomWindow(element: Element): DomConstructorWindow {
    return (element.ownerDocument.defaultView ?? activeWindow) as DomConstructorWindow;
  }

  private isSvgImage(image: HTMLImageElement): boolean {
    const source = image.currentSrc || image.src || image.getAttribute("src") || "";
    return this.getImageVaultPath(image) !== null || /^https?:\/\/.*\.svg(?:[?#].*)?$/i.test(source);
  }

  private getImageVaultPath(image: HTMLImageElement): string | null {
    const candidates = [
      image.getAttribute("data-path"),
      image.getAttribute("alt"),
      image.getAttribute("src"),
      image.currentSrc,
      image.src,
    ];

    for (const candidate of candidates) {
      const vaultPath = this.extractSvgVaultPath(candidate ?? "");
      if (vaultPath) {
        return vaultPath;
      }
    }
    return null;
  }

  private decodeUri(value: string): string {
    try {
      return decodeURI(value);
    } catch {
      return value;
    }
  }

  private extractSvgVaultPath(source: string): string | null {
    if (!source) {
      return null;
    }

    const decodedSource = this.decodeUri(source);
    const directPath = this.toExistingSvgVaultPath(decodedSource);
    if (directPath) {
      return directPath;
    }

    const pathMatch = decodedSource.match(/[?&](?:path|file)=([^&#]+\.svg)(?:[&#]|$)/i);
    if (pathMatch) {
      const queryPath = this.toExistingSvgVaultPath(this.decodeUriComponent(pathMatch[1]));
      if (queryPath) {
        return queryPath;
      }
    }

    const localUrlPath = this.getLocalPathFromUrl(decodedSource);
    if (localUrlPath) {
      const vaultPath = this.toExistingSvgVaultPath(localUrlPath);
      if (vaultPath) {
        return vaultPath;
      }
    }

    const svgMatch = decodedSource.match(/(?:^|[/\\])([^?#]+\.svg)(?:[?#]|$)/i);
    if (svgMatch) {
      return this.toExistingSvgVaultPath(svgMatch[1]);
    }
    return null;
  }

  private toExistingSvgVaultPath(path: string): string | null {
    const normalized = normalizePath(path.replace(/^\/+([A-Za-z]:\/)/, "$1"));
    if (!normalized.toLowerCase().endsWith(".svg")) {
      return null;
    }

    if (this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) {
      return normalized;
    }

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return null;
    }

    const basePath = normalizePath(adapter.getBasePath());
    if (normalized === basePath) {
      return null;
    }
    if (!normalized.startsWith(`${basePath}/`)) {
      return null;
    }

    const vaultPath = normalizePath(normalized.slice(basePath.length + 1));
    return this.app.vault.getAbstractFileByPath(vaultPath) instanceof TFile ? vaultPath : null;
  }

  private getLocalPathFromUrl(source: string): string | null {
    try {
      const url = new URL(source);
      if (url.protocol !== "app:" && url.protocol !== "file:") {
        return null;
      }
      return this.decodeUriComponent(url.pathname).replace(/^\/+([A-Za-z]:\/)/, "$1");
    } catch {
      return null;
    }
  }

  private decodeUriComponent(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private getSuggestedImageName(image: HTMLImageElement): string {
    const vaultPath = this.getImageVaultPath(image);
    if (vaultPath) {
      return this.basename(vaultPath);
    }
    const alt = image.getAttribute("alt");
    if (alt) {
      return this.slugify(alt.replace(/\.svg$/i, ""));
    }
    return "svg-export";
  }

  private async exportSvgTarget(target: SvgTarget, format: ExportImageFormat) {
    try {
      const svgText = this.ensureSvgNamespace(await this.getSvgText(target));
      const baseName = target.suggestedName.replace(/\.svg$/i, "");
      await this.exportSvgText(svgText, baseName, format, { sourcePath: target.sourcePath, heading: baseName });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      console.error(error);
      new Notice(this.t("notice.exportSvgFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async exportSvgText(svgText: string, baseName: string, format: ExportImageFormat, options: FilenameTokenOptions = {}) {
    const raster = await this.rasterizeSvg(svgText, format);
    const extension = format === "jpeg" ? "jpg" : "png";
    const filename = this.buildImageFilename(baseName, format, extension, options);
    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    const blob = new Blob([raster], { type: mimeType });
    const saved = await this.saveImageBlob(blob, filename, mimeType, extension);
    this.recordLastExport({
      type: "svg",
      svgText,
      baseName,
      format,
      options,
      label: this.t("action.exportImage", { name: baseName, format: format.toUpperCase() }),
    });
    await this.recordSavedFile(saved, "image-save", this.t("action.exportImage", { name: baseName, format: format.toUpperCase() }));
    if (this.settings.afterImageExportInsertMarkdownLink && saved.vaultPath) {
      this.insertMarkdownLinkForExport(saved.vaultPath);
    }
    new Notice(this.t("notice.savedImage", { format: format.toUpperCase(), path: saved.vaultPath ?? saved.systemPath ?? saved.filename }));
  }

  private buildImageFilename(baseName: string, format: ExportImageFormat, extension: string, options: FilenameTokenOptions = {}): string {
    const filename = renderFilenameTemplate(this.settings.imageFilenameTemplate, this.getFilenameTokens(baseName, format, options), baseName);
    return `${filename}.${extension}`;
  }

  private async saveImageBlob(blob: Blob, filename: string, mimeType: string, extension: string): Promise<SavedFileResult> {
    if (this.settings.imageSaveMode === "vault") {
      const vaultPath = await this.saveImageBlobToVault(blob, filename);
      return { filename, vaultPath };
    }

    const systemPath = await this.saveBlobWithPicker(blob, filename, mimeType, extension);
    return { filename, systemPath: systemPath ?? undefined };
  }

  private async saveImageBlobToVault(blob: Blob, filename: string): Promise<string> {
    await this.ensureFolder(this.settings.imageOutputFolder);
    const outputPath = await this.nextAvailablePath(this.settings.imageOutputFolder, filename);
    await this.app.vault.adapter.writeBinary(outputPath, await blob.arrayBuffer());
    return outputPath;
  }

  private async saveBlobWithPicker(blob: Blob, filename: string, mimeType: string, extension: string): Promise<string | null> {
    if (Platform.isDesktopApp) {
      const systemPath = await this.saveBlobWithElectronDialog(blob, filename, extension);
      if (systemPath) {
        return systemPath;
      }
    }

    const savePicker = (window as WindowWithSavePicker).showSaveFilePicker;
    if (savePicker) {
      const handle = await savePicker({
        suggestedName: filename,
        types: [
          {
            description: this.t("dialog.imageType", { format: extension.toUpperCase() }),
            accept: { [mimeType]: [`.${extension}`] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return null;
    }

    this.downloadBlobWithAnchor(blob, filename);
    return null;
  }

  private async saveBlobWithElectronDialog(blob: Blob, filename: string, extension: string): Promise<string | null> {
    const dialog = remote?.dialog;
    if (!dialog) {
      return null;
    }

    const result = await dialog.showSaveDialog({
      title: this.t("dialog.saveSvg"),
      defaultPath: filename,
      filters: [{ name: this.t("dialog.imageType", { format: extension.toUpperCase() }), extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) {
      throw new DOMException("Save cancelled", "AbortError");
    }

    const buffer = new Uint8Array(await blob.arrayBuffer());
    await writeFile(result.filePath, buffer);
    return result.filePath;
  }

  private downloadBlobWithAnchor(blob: Blob, filename: string) {
    const objectUrl = URL.createObjectURL(blob);
    const link = activeDocument.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.addClass("owen-exporter-download-link");
    activeDocument.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  private async getSvgText(target: SvgTarget): Promise<string> {
    if (target.sourcePath) {
      const file = this.app.vault.getAbstractFileByPath(target.sourcePath);
      if (file instanceof TFile) {
        return this.app.vault.read(file);
      }
    }

    const source = target.element.currentSrc || target.element.src;
    if (!/^https?:\/\//i.test(source)) {
      throw new Error("Unable to resolve local SVG file path");
    }

    const response = await requestUrl({ url: source });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Unable to read SVG image (${response.status})`);
    }
    return response.text;
  }

  private async rasterizeSvg(svgText: string, format: ExportImageFormat): Promise<ArrayBuffer> {
    const image = activeDocument.createElement("img");
    this.assertParsableSvg(svgText);
    const dimensions = getSvgDimensionsFromText(svgText);
    const scale = this.getImageScale();
    const hasExternalReferences = this.hasExternalSvgReferences(svgText);
    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);

    try {
      await new Promise<HTMLImageElement>((resolve, reject) => {
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Browser could not rasterize this SVG. Check for malformed SVG markup or blocked external resources."));
        image.src = objectUrl;
      });

      const width = Math.max(1, Math.round(dimensions.width * scale));
      const height = Math.max(1, Math.round(dimensions.height * scale));
      this.assertCanvasSize(width, height);
      const canvas = activeDocument.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas rendering is unavailable");
      }

      if (format === "jpeg" || this.settings.imageBackground.trim().toLowerCase() !== "transparent") {
        if (!this.isValidCssColor(this.settings.imageBackground)) {
          throw new Error(`Invalid image background color: ${this.settings.imageBackground}`);
        }
        context.fillStyle = this.settings.imageBackground || "#FFFFFF";
        context.fillRect(0, 0, width, height);
      }

      let outputBlob: Blob;
      try {
        context.drawImage(image, 0, 0, width, height);
        const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
        outputBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (result) => (result ? resolve(result) : reject(new Error("Canvas export failed"))),
            mimeType,
            this.getImageQuality(),
          );
        });
      } catch (error) {
        if (hasExternalReferences) {
          throw new Error("Canvas export was blocked. This SVG references external images, fonts, or styles that may need to be embedded first.");
        }
        throw error;
      }
      return outputBlob.arrayBuffer();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  private assertParsableSvg(svgText: string) {
    const parsedDocument = new DOMParser().parseFromString(svgText, "image/svg+xml");
    if (parsedDocument.querySelector("parsererror")) {
      throw new Error("Invalid SVG markup. The file could not be parsed as XML.");
    }
    if (!parsedDocument.querySelector("svg")) {
      throw new Error("Invalid SVG markup. No <svg> root element was found.");
    }
  }

  private getImageScale(): number {
    const scale = Number(this.settings.imageScale);
    return Number.isFinite(scale) && scale > 0 ? scale : DEFAULT_SETTINGS.imageScale;
  }

  private getImageQuality(): number {
    const quality = Number(this.settings.imageQuality);
    if (!Number.isFinite(quality)) {
      return DEFAULT_SETTINGS.imageQuality;
    }
    return Math.min(1, Math.max(0.1, quality));
  }

  private assertCanvasSize(width: number, height: number) {
    const pixels = width * height;
    if (pixels > MAX_CANVAS_PIXELS) {
      throw new Error(`Export is too large (${width}x${height}). Lower the image scale and try again.`);
    }
  }

  private hasExternalSvgReferences(svgText: string): boolean {
    return /(?:href|xlink:href)=["']https?:\/\//i.test(svgText) || /url\(["']?https?:\/\//i.test(svgText) || /@import\s+url\(["']?https?:\/\//i.test(svgText);
  }

  private getSvgExportWarnings(svgText: string, format: ExportImageFormat): string[] {
    const warnings: string[] = [];
    this.assertParsableSvg(svgText);
    const dimensions = getSvgDimensionsFromText(svgText);
    const scale = this.getImageScale();
    const width = Math.max(1, Math.round(dimensions.width * scale));
    const height = Math.max(1, Math.round(dimensions.height * scale));

    if (this.hasExternalSvgReferences(svgText)) {
      warnings.push(this.t("warning.externalReferences"));
    }
    if (width * height > MAX_CANVAS_PIXELS) {
      warnings.push(this.t("warning.outputTooLarge", { width, height }));
    }
    if ((format === "jpeg" || this.settings.imageBackground.trim().toLowerCase() !== "transparent") && !this.isValidCssColor(this.settings.imageBackground)) {
      warnings.push(this.t("warning.invalidBackground", { color: this.settings.imageBackground }));
    }

    return warnings;
  }

  private async diagnoseSvgTarget(target: SvgTarget) {
    try {
      const svgText = this.ensureSvgNamespace(await this.getSvgText(target));
      const dimensions = getSvgDimensionsFromText(svgText);
      const warnings = this.getSvgExportWarnings(svgText, this.settings.imageFormat);
      if (warnings.length) {
        console.warn("Owen Exporter SVG diagnostics", warnings);
        new Notice(this.t("notice.svgWarning", { detail: warnings[0] }));
        return;
      }
      new Notice(this.t("notice.svgReady", { width: Math.round(dimensions.width), height: Math.round(dimensions.height), scale: this.getImageScale() }));
    } catch (error) {
      console.error(error);
      new Notice(this.t("notice.svgDiagnosticFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }

  private isValidCssColor(value: string): boolean {
    const color = value.trim();
    if (!color || color.toLowerCase() === "transparent") {
      return true;
    }
    const option = new Option();
    option.style.color = color;
    return Boolean(option.style.color);
  }

  private ensureSvgNamespace(svgText: string): string {
    if (/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(svgText)) {
      return svgText;
    }
    return svgText.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  private async copySelectionAsHtml(editor: Editor, view: MarkdownSourceInfo) {
    const html = await this.renderMarkdownToHtml(editor.getSelection(), view.file?.path ?? "");
    await this.copyHtmlExport(html, view.file?.path ?? null, "selection");
  }

  private async previewSelectionAsHtml(editor: Editor, view: MarkdownSourceInfo) {
    const html = await this.renderMarkdownToHtml(editor.getSelection(), view.file?.path ?? "");
    this.openHtmlPreview(this.t("preview.selectionTitle"), html, view.file?.path ?? null, "selection");
  }

  private async saveSelectionAsHtml(editor: Editor, view: MarkdownSourceInfo) {
    const html = await this.renderMarkdownToHtml(editor.getSelection(), view.file?.path ?? "");
    await this.saveHtmlToFile(html, view.file?.path ?? null, "selection");
  }

  private async previewCurrentNoteAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    const html = await this.renderMarkdownToHtml(markdown, view.file.path);
    this.openHtmlPreview(this.t("preview.noteTitle"), html, view.file.path, "note");
  }

  private async compareCurrentNoteHtmlStyles(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    await this.compareMarkdownHtmlStyles(markdown, view.file.path, this.t("compare.noteTitle", { name: view.file.basename }));
  }

  private async saveCurrentNoteAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const file = view.file;
    const markdown = await this.app.vault.read(file);
    await this.withNoteExportMetadata(markdown, async () => {
      const html = await this.renderMarkdownToHtml(markdown, file.path);
      await this.saveHtmlToFile(html, file.path, "note");
    });
  }

  private openHtmlPreview(title: string, html: string, sourcePath: string | null, fallbackName: string) {
    new HtmlPreviewModal(this.app, this.t.bind(this), {
      title,
      html,
      onCopy: () => this.copyHtmlExport(html, sourcePath, fallbackName),
      onSave: async () => {
        await this.saveHtmlToFile(html, sourcePath, fallbackName);
      },
    }).open();
  }

  private async renderMarkdownToHtml(markdown: string, sourcePath: string): Promise<string> {
    const container = this.createHiddenMarkdownRenderHost();
    const renderComponent = new Component();
    activeDocument.body.appendChild(container);
    renderComponent.load();
    try {
      await MarkdownRenderer.render(this.app, this.preprocessMarkdown(markdown), container, sourcePath, renderComponent);
      this.inlinePreviewStyles(container);
      this.applyHtmlQualityOptions(container, sourcePath);
      await this.applyHtmlAssetOptions(container, sourcePath);
      return container.innerHTML.trim();
    } finally {
      renderComponent.unload();
      container.remove();
    }
  }

  private preprocessMarkdown(markdown: string): string {
    if (!this.settings.htmlExcludeFrontmatter) {
      return markdown;
    }
    return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  }

  private applyHtmlQualityOptions(container: HTMLElement, sourcePath: string) {
    if (!this.settings.htmlPreserveHeadingIds) {
      for (const heading of Array.from(container.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]"))) {
        heading.removeAttribute("id");
      }
    }

    if (!this.settings.htmlPreserveCalloutClasses) {
      for (const callout of Array.from(container.querySelectorAll<HTMLElement>(".callout"))) {
        callout.removeAttribute("data-callout");
        callout.removeClass("callout");
      }
    }

    if (this.settings.htmlConvertInternalLinksToObsidianUris) {
      for (const link of Array.from(container.querySelectorAll<HTMLAnchorElement>("a.internal-link, a[href]"))) {
        const href = link.getAttribute("href") ?? "";
        if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) {
          continue;
        }
        const linkText = link.getAttribute("data-href") ?? href;
        const file = this.app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
        const targetPath = file?.path ?? linkText;
        link.href = `obsidian://open?path=${encodeURIComponent(targetPath)}`;
      }
    }
  }

  private async applyHtmlAssetOptions(container: HTMLElement, sourcePath: string) {
    if (this.settings.htmlAssetMode === "keep") {
      return;
    }
    const images = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
    for (const image of images) {
      const file = this.resolveImageFileForHtml(image, sourcePath);
      if (!file) {
        continue;
      }
      if (this.settings.htmlAssetMode === "base64") {
        const data = await this.app.vault.adapter.readBinary(file.path);
        image.src = `data:${this.getMimeType(file.path)};base64,${this.arrayBufferToBase64(data)}`;
      } else if (this.settings.htmlAssetMode === "copy") {
        const copiedPath = await this.copyHtmlAsset(file);
        image.src = this.getRelativePath(this.settings.htmlOutputFolder, copiedPath);
      } else if (this.settings.htmlAssetMode === "relative") {
        image.src = this.getRelativePath(this.settings.htmlOutputFolder, file.path);
      }
    }
  }

  private resolveImageFileForHtml(image: HTMLImageElement, sourcePath: string): TFile | null {
    const candidates = [
      image.getAttribute("data-path"),
      image.getAttribute("alt"),
      image.getAttribute("src"),
      image.currentSrc,
      image.src,
    ];
    for (const candidate of candidates) {
      const file = this.resolveVaultFile(candidate ?? "", sourcePath);
      if (file) {
        return file;
      }
    }
    return null;
  }

  private resolveVaultFile(value: string, sourcePath: string): TFile | null {
    if (!value) {
      return null;
    }
    const decoded = this.decodeUri(value);
    const localPath = this.getLocalPathFromUrl(decoded) ?? decoded.replace(/[?#].*$/, "");
    const direct = this.toExistingVaultPath(localPath);
    if (direct) {
      return direct;
    }
    const link = localPath.split("/").pop() ?? localPath;
    const file = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
    return file instanceof TFile ? file : null;
  }

  private toExistingVaultPath(path: string): TFile | null {
    const normalized = normalizePath(path.replace(/^\/+([A-Za-z]:\/)/, "$1"));
    const direct = this.app.vault.getAbstractFileByPath(normalized);
    if (direct instanceof TFile) {
      return direct;
    }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return null;
    }
    const basePath = normalizePath(adapter.getBasePath());
    if (!normalized.startsWith(`${basePath}/`)) {
      return null;
    }
    const vaultPath = normalizePath(normalized.slice(basePath.length + 1));
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    return file instanceof TFile ? file : null;
  }

  private async copyHtmlAsset(file: TFile): Promise<string> {
    const folder = normalizeVaultFolder(this.settings.htmlAssetOutputFolder || DEFAULT_SETTINGS.htmlAssetOutputFolder);
    await this.ensureFolder(folder);
    const filename = file.path.split("/").pop() ?? file.name;
    const outputPath = await this.nextAvailablePath(folder, filename);
    await this.app.vault.adapter.writeBinary(outputPath, await this.app.vault.adapter.readBinary(file.path));
    return outputPath;
  }

  private getRelativePath(fromFolder: string, toPath: string): string {
    const fromParts = normalizeVaultFolder(fromFolder).split("/").filter(Boolean);
    const toParts = normalizePath(toPath).split("/").filter(Boolean);
    while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
      fromParts.shift();
      toParts.shift();
    }
    return [...fromParts.map(() => ".."), ...toParts].join("/") || toPath;
  }

  private getMimeType(path: string): string {
    const extension = path.split(".").pop()?.toLowerCase();
    if (extension === "jpg" || extension === "jpeg") {
      return "image/jpeg";
    }
    if (extension === "svg") {
      return "image/svg+xml";
    }
    if (extension === "webp") {
      return "image/webp";
    }
    if (extension === "gif") {
      return "image/gif";
    }
    return "image/png";
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.byteLength; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  private async withNoteExportMetadata<T>(markdown: string, run: () => Promise<T>): Promise<T> {
    const metadata = this.parseNoteExportMetadata(markdown);
    if (!metadata) {
      return run();
    }
    return this.withTemporarySettings(this.getSettingsFromNoteMetadata(metadata), run);
  }

  private parseNoteExportMetadata(markdown: string): NoteExportMetadata | null {
    const match = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) {
      return null;
    }
    const lines = match[1].split(/\r?\n/);
    const start = lines.findIndex((line) => /^owen-export\s*:\s*$/.test(line));
    if (start < 0) {
      return null;
    }
    const metadata: Record<string, string> = {};
    for (const line of lines.slice(start + 1)) {
      if (!/^\s+/.test(line)) {
        break;
      }
      const entry = line.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (entry) {
        metadata[entry[1]] = entry[2].replace(/^['"]|['"]$/g, "");
      }
    }
    return {
      profile: metadata.profile,
      filename: metadata.filename,
      style: this.isHtmlStyleMode(metadata.style) ? metadata.style : undefined,
      saveMode: this.isHtmlSaveMode(metadata.saveMode) ? metadata.saveMode : undefined,
      title: metadata.title,
      assetMode: this.isHtmlAssetMode(metadata.assetMode) ? metadata.assetMode : undefined,
    };
  }

  private getSettingsFromNoteMetadata(metadata: NoteExportMetadata): Partial<OwenExporterSettings> {
    const settings: Partial<OwenExporterSettings> = {};
    if (metadata.profile) {
      Object.assign(settings, this.getHtmlProfileSettings(metadata.profile));
    }
    if (metadata.filename) {
      settings.htmlFilenameTemplate = metadata.filename;
    }
    if (metadata.style) {
      settings.htmlStyleMode = metadata.style;
    }
    if (metadata.saveMode) {
      settings.htmlSaveMode = metadata.saveMode;
    }
    if (metadata.title) {
      settings.htmlDocumentTitle = metadata.title;
    }
    if (metadata.assetMode) {
      settings.htmlAssetMode = metadata.assetMode;
    }
    return settings;
  }

  private getHtmlProfileSettings(name: string): Partial<OwenExporterSettings> {
    if (name in HTML_EXPORT_PROFILES) {
      return HTML_EXPORT_PROFILES[name as Exclude<HtmlExportProfile, "custom">];
    }
    const profile = this.settings.htmlCustomProfiles.find((candidate) => candidate.name === name);
    if (!profile) {
      return {};
    }
    return {
      htmlOutputFolder: profile.htmlOutputFolder,
      htmlFilenameTemplate: profile.htmlFilenameTemplate,
      htmlSaveMode: profile.htmlSaveMode,
      htmlStyleMode: profile.htmlStyleMode,
      htmlClipboardMode: profile.htmlClipboardMode,
      htmlDocumentTitle: profile.htmlDocumentTitle,
      htmlExcludeFrontmatter: profile.htmlExcludeFrontmatter,
      htmlPreserveHeadingIds: profile.htmlPreserveHeadingIds,
      htmlPreserveCalloutClasses: profile.htmlPreserveCalloutClasses,
      htmlConvertInternalLinksToObsidianUris: profile.htmlConvertInternalLinksToObsidianUris,
      htmlAssetMode: profile.htmlAssetMode,
      htmlAssetOutputFolder: profile.htmlAssetOutputFolder,
      htmlDocumentTemplate: profile.htmlDocumentTemplate,
    };
  }

  private isHtmlStyleMode(value: string | undefined): value is HtmlStyleMode {
    return value === "obsidian" || value === "portable" || value === "clean";
  }

  private isHtmlSaveMode(value: string | undefined): value is HtmlSaveMode {
    return value === "document" || value === "fragment";
  }

  private isHtmlAssetMode(value: string | undefined): value is HtmlAssetMode {
    return value === "keep" || value === "relative" || value === "copy" || value === "base64";
  }

  private wrapHtmlDocument(fragment: string, title: string, tokens: Record<string, string | number>, sourcePath: string | null): string {
    const template = this.settings.htmlDocumentTemplate.trim();
    if (template) {
      return this.renderTextTemplate(template, {
        ...tokens,
        title,
        content: fragment,
        sourcePath: sourcePath ?? "",
        style: this.settings.htmlStyleMode,
      }, fragment);
    }
    return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${this.escapeHtml(title)}</title>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private async copyHtmlExport(html: string, sourcePath: string | null, fallbackName: string) {
    await this.copyHtmlToClipboard(html);
    this.recordLastExport({
      type: "html-copy",
      html,
      sourcePath,
      fallbackName,
      label: this.t("action.copyHtml", { name: fallbackName }),
    });
  }

  private async copyHtmlToClipboard(html: string) {
    const plainText = this.htmlToPlainText(html);
    if (this.settings.htmlClipboardMode === "text") {
      await navigator.clipboard.writeText(plainText);
    } else if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
      const clipboardPayload: Record<string, Blob> = {
        "text/html": new Blob([html], { type: "text/html" }),
      };
      if (this.settings.htmlClipboardMode === "html-and-text") {
        clipboardPayload["text/plain"] = new Blob([plainText], { type: "text/plain" });
      }
      await navigator.clipboard.write([
        new ClipboardItem(clipboardPayload),
      ]);
    } else {
      await navigator.clipboard.writeText(plainText);
    }
    new Notice(this.t("notice.copiedHtml"));
  }

  private async saveHtmlToFile(html: string, sourcePath: string | null, fallbackName: string): Promise<SavedFileResult> {
    await this.ensureFolder(this.settings.htmlOutputFolder);
    const baseName = sourcePath ? this.basename(sourcePath) : fallbackName;
    const tokens = this.getFilenameTokens(baseName, "html", { sourcePath, heading: baseName });
    const filename = `${renderFilenameTemplate(this.settings.htmlFilenameTemplate, tokens, baseName)}.html`;
    const outputPath = await this.nextAvailablePath(this.settings.htmlOutputFolder, filename);
    const title = this.renderTextTemplate(this.settings.htmlDocumentTitle, tokens, `${baseName} export`);
    const content = this.settings.htmlSaveMode === "document" ? this.wrapHtmlDocument(html, title, tokens, sourcePath) : html;
    await this.app.vault.adapter.write(outputPath, content);
    await this.recordSavedFile({ filename, vaultPath: outputPath }, "html-save", this.t("action.saveHtml", { name: fallbackName }));
    this.recordLastExport({
      type: "html-save",
      html,
      sourcePath,
      fallbackName,
      label: this.t("action.saveHtml", { name: fallbackName }),
    });
    new Notice(this.t("notice.savedHtml", { path: outputPath }));
    return { filename, vaultPath: outputPath };
  }

  private htmlToPlainText(html: string): string {
    const container = activeDocument.createElement("div");
    container.appendChild(sanitizeHTMLToDom(html));
    return container.innerText.trim() || container.textContent?.trim() || "";
  }

  private getSelectedHtmlFragment(range: Range): string {
    const container = this.createHiddenMarkdownRenderHost();
    container.appendChild(range.cloneContents());
    activeDocument.body.appendChild(container);
    try {
      this.inlinePreviewStyles(container);
      return container.innerHTML.trim();
    } finally {
      container.remove();
    }
  }

  private createHiddenMarkdownRenderHost(): HTMLDivElement {
    const container = activeDocument.createElement("div");
    container.addClass("owen-exporter-render-root");
    container.addClass("markdown-preview-view");
    container.addClass("markdown-rendered");
    container.setAttribute("aria-hidden", "true");
    container.style.width = this.getActiveMarkdownWidth();
    return container;
  }

  private getActiveMarkdownWidth(): string {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const sourceWidth = activeView?.contentEl?.getBoundingClientRect().width;
    if (sourceWidth && sourceWidth > 0) {
      return `${Math.round(sourceWidth)}px`;
    }
    return "760px";
  }

  private inlinePreviewStyles(container: HTMLElement) {
    if (this.settings.htmlStyleMode === "clean") {
      this.stripInlineStyles(container);
      return;
    }

    const properties = this.settings.htmlStyleMode === "portable" ? HTML_PORTABLE_STYLE_PROPERTIES : HTML_STYLE_PROPERTIES;
    const includeVariables = this.settings.htmlStyleMode === "obsidian";
    this.inlineElementStyle(container, properties, includeVariables);
    const elements = Array.from(container.querySelectorAll<HTMLElement>(HTML_STYLE_SELECTOR));
    for (const element of elements) {
      this.inlineElementStyle(element, properties, includeVariables);
    }
  }

  private inlineElementStyle(element: HTMLElement, properties: string[], includeVariables: boolean) {
    const computed = activeWindow.getComputedStyle(element);
    const styles: Record<string, string> = {};
    for (const property of properties) {
      const value = computed.getPropertyValue(property);
      if (value) {
        styles[property] = value;
      }
    }
    if (includeVariables) {
      for (const variable of HTML_STYLE_VARIABLES) {
        const value = computed.getPropertyValue(variable);
        if (value) {
          styles[variable] = value;
        }
      }
    }
    this.normalizePortableHtmlStyles(element, styles);
    element.setCssProps(styles);
  }

  private stripInlineStyles(container: HTMLElement) {
    container.removeAttribute("style");
    const styledElements = Array.from(container.querySelectorAll<HTMLElement>("[style]"));
    for (const element of styledElements) {
      element.removeAttribute("style");
    }
  }

  private normalizePortableHtmlStyles(element: HTMLElement, styles: Record<string, string>) {
    if (element.matches("h1, h2, h3, h4, h5, h6")) {
      this.normalizeHeadingStyles(styles);
      return;
    }

    if (element.matches("hr")) {
      this.normalizeRuleStyles(styles);
    }
  }

  private normalizeHeadingStyles(styles: Record<string, string>) {
    for (const property of ["display", "flex", "height", "min-width", "max-width", "overflow", "overflow-x", "overflow-y", "width"]) {
      delete styles[property];
    }
    this.clampPixelStyle(styles, "margin-bottom", 12);
    this.clampPixelStyle(styles, "padding-bottom", 8);
  }

  private normalizeRuleStyles(styles: Record<string, string>) {
    for (const property of ["height", "min-width", "max-width", "overflow", "overflow-x", "overflow-y", "width"]) {
      delete styles[property];
    }
    this.clampPixelStyle(styles, "margin-top", 12);
    this.clampPixelStyle(styles, "margin-bottom", 16);
  }

  private clampPixelStyle(styles: Record<string, string>, property: string, maxPixels: number) {
    const value = styles[property];
    if (!value?.endsWith("px")) {
      return;
    }
    const pixels = Number.parseFloat(value);
    if (Number.isFinite(pixels) && pixels > maxPixels) {
      styles[property] = `${maxPixels}px`;
    }
  }

  private async exportCurrentFolderNotesAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const folder = this.getFolderPath(view.file.path);
    const files = this.app.vault.getMarkdownFiles().filter((file) => this.getFolderPath(file.path) === folder);
    await this.exportMarkdownFilesAsHtml(files, folder || this.t("scope.vaultRoot"));
  }

  private async exportChangedCurrentFolderNotesAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const folder = this.getFolderPath(view.file.path);
    const files = await this.filterChangedMarkdownFiles(this.app.vault.getMarkdownFiles().filter((file) => this.getFolderPath(file.path) === folder));
    await this.exportMarkdownFilesAsHtml(files, this.t("scope.folder", { folder: folder || this.t("scope.vaultRoot") }));
  }

  private async exportLinkedNotesAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    const files = this.getLinkedMarkdownFiles(markdown, view.file.path);
    await this.exportMarkdownFilesAsHtml(files, this.t("scope.links", { name: view.file.basename }));
  }

  private async exportChangedLinkedNotesAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    const files = await this.filterChangedMarkdownFiles(this.getLinkedMarkdownFiles(markdown, view.file.path));
    await this.exportMarkdownFilesAsHtml(files, this.t("scope.changedLinks", { name: view.file.basename }));
  }

  private async exportMarkdownFilesAsHtml(files: TFile[], label: string) {
    if (!files.length) {
      new Notice(this.t("notice.noNotes"));
      return;
    }
    let savedCount = 0;
    const failures: string[] = [];
    const manifestEntries: ExportManifestEntry[] = [];
    const job = this.createExportJob(this.t("job.title", { label }), files.map((file) => file.path));
    for (const [index, file] of files.entries()) {
      if (job.cancelled) {
        job.modal.updateEntry(index, "skipped", this.t("job.cancelled"));
        manifestEntries.push(this.createManifestEntry(file, "skipped", undefined, "Cancelled"));
        continue;
      }
      job.modal.updateEntry(index, "running");
      try {
        const markdown = await this.app.vault.read(file);
        const saved = await this.withNoteExportMetadata(markdown, async () => {
          const html = await this.renderMarkdownToHtml(markdown, file.path);
          return this.saveHtmlToFile(html, file.path, "note");
        });
        manifestEntries.push(this.createManifestEntry(file, "success", saved.vaultPath));
        job.modal.updateEntry(index, "success", saved.vaultPath);
        savedCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${file.path}: ${message}`);
        manifestEntries.push(this.createManifestEntry(file, "failed", undefined, message));
        job.modal.updateEntry(index, "failed", message);
      }
    }
    await this.maybeWriteExportManifest(label, manifestEntries);
    if (failures.length) {
      console.warn("Owen Exporter HTML batch export failures", failures);
      new Notice(this.t("notice.batchPartial", { saved: savedCount, total: files.length, label }));
      return;
    }
    new Notice(this.t("notice.batchSuccess", { saved: savedCount, label }));
  }

  private createExportJob(title: string, labels: string[]): ExportJobController {
    const modal = new ExportJobModal(this.app, this.t.bind(this), title, labels);
    const controller: ExportJobController = { modal, cancelled: false };
    modal.onCancel = () => {
      controller.cancelled = true;
    };
    modal.open();
    return controller;
  }

  private createManifestEntry(file: TFile, status: "success" | "failed" | "skipped", outputPath?: string, error?: string): ExportManifestEntry {
    return {
      sourcePath: file.path,
      outputPath,
      status,
      error,
      sourceMtime: file.stat.mtime,
      profile: this.settings.htmlExportProfile,
      styleMode: this.settings.htmlStyleMode,
      saveMode: this.settings.htmlSaveMode,
      createdAt: new Date().toISOString(),
    };
  }

  private async maybeWriteExportManifest(label: string, entries: ExportManifestEntry[]): Promise<string | null> {
    if (!this.settings.writeExportManifest || !entries.length) {
      return null;
    }
    await this.ensureFolder(this.settings.htmlOutputFolder);
    const manifest: ExportManifest = {
      version: 1,
      pluginVersion: this.manifest.version,
      createdAt: new Date().toISOString(),
      label,
      entries,
    };
    const outputPath = normalizePath(`${normalizeVaultFolder(this.settings.htmlOutputFolder)}/export-manifest.json`);
    await this.app.vault.adapter.write(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await this.recordSavedFile({ filename: "export-manifest.json", vaultPath: outputPath }, "report", this.t("action.exportManifest"));
    return outputPath;
  }

  private async filterChangedMarkdownFiles(files: TFile[]): Promise<TFile[]> {
    const manifest = await this.readLatestExportManifest();
    if (!manifest) {
      return files;
    }
    const lastBySource = new Map(manifest.entries.filter((entry) => entry.status === "success").map((entry) => [entry.sourcePath, entry]));
    return files.filter((file) => {
      const previous = lastBySource.get(file.path);
      return !previous?.sourceMtime || file.stat.mtime > previous.sourceMtime;
    });
  }

  private async readLatestExportManifest(): Promise<ExportManifest | null> {
    const path = normalizePath(`${normalizeVaultFolder(this.settings.htmlOutputFolder)}/export-manifest.json`);
    if (!(await this.app.vault.adapter.exists(path))) {
      return null;
    }
    try {
      return JSON.parse(await this.app.vault.adapter.read(path)) as ExportManifest;
    } catch {
      return null;
    }
  }

  private getLinkedMarkdownFiles(markdown: string, sourcePath: string): TFile[] {
    const seen = new Set<string>();
    const files: TFile[] = [];
    const addLink = (rawLink: string) => {
      const cleanLink = rawLink.trim().replace(/^<|>$/g, "").replace(/[?#].*$/, "");
      if (!cleanLink || /^[a-z][a-z0-9+.-]*:/i.test(cleanLink)) {
        return;
      }
      const file = this.app.metadataCache.getFirstLinkpathDest(cleanLink.replace(/\.md$/i, ""), sourcePath);
      if (file instanceof TFile && file.extension.toLowerCase() === "md" && !seen.has(file.path)) {
        seen.add(file.path);
        files.push(file);
      }
    };
    for (const match of markdown.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      addLink(match[1]);
    }
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+?)(?:\.md)?(?:[?#][^)]*)?\)/g)) {
      addLink(match[1]);
    }
    return files;
  }

  private getFolderPath(path: string): string {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  private openExportHistory() {
    new ExportHistoryModal(this.app, this.t.bind(this), this.locale, this.recentExports, {
      open: (entry) => this.openExportedResult(entry),
      reveal: (entry) => this.revealExportedResult(entry),
      copyPath: async (entry) => {
        await navigator.clipboard.writeText(entry.systemPath ?? entry.vaultPath ?? entry.filename);
        new Notice(this.t("notice.copiedExportPath"));
      },
      clear: () => {
        this.recentExports = [];
        new Notice(this.t("notice.historyCleared"));
      },
    }).open();
  }

  private async compareMarkdownHtmlStyles(markdown: string, sourcePath: string, title: string) {
    const [obsidianHtml, portableHtml, cleanHtml] = await Promise.all([
      this.withTemporarySettings({ htmlStyleMode: "obsidian" }, () => this.renderMarkdownToHtml(markdown, sourcePath)),
      this.withTemporarySettings({ htmlStyleMode: "portable" }, () => this.renderMarkdownToHtml(markdown, sourcePath)),
      this.withTemporarySettings({ htmlStyleMode: "clean" }, () => this.renderMarkdownToHtml(markdown, sourcePath)),
    ]);
    new HtmlCompareModal(this.app, title, [
      { label: this.t("compare.obsidian"), html: obsidianHtml },
      { label: this.t("compare.portable"), html: portableHtml },
      { label: this.t("compare.clean"), html: cleanHtml },
    ]).open();
  }

  openHtmlProfileSwitcher() {
    const profiles = [
      { name: "obsidian-document", label: this.t("profile.obsidian") },
      { name: "portable-document", label: this.t("profile.portable") },
      { name: "clean-fragment", label: this.t("profile.clean") },
      ...this.settings.htmlCustomProfiles.map((profile) => ({ name: profile.name, label: profile.name })),
    ];
    new ProfileSwitcherModal(this.app, this.t.bind(this), profiles, async (name) => {
      Object.assign(this.settings, name in HTML_EXPORT_PROFILES ? HTML_EXPORT_PROFILES[name as Exclude<HtmlExportProfile, "custom">] : this.getHtmlProfileSettings(name));
      this.settings.htmlExportProfile = name in HTML_EXPORT_PROFILES ? name as HtmlExportProfile : "custom";
      await this.saveSettings();
      new Notice(this.t("notice.profileUsing", { name }));
    }).open();
  }

  private async validateCurrentNoteExport(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    const issues = await this.validateMarkdownExport(markdown, view.file.path);
    const outputPath = await this.writeValidationReport(view.file.path, issues);
    if (issues.length) {
      new Notice(this.t("notice.validationIssues", { count: issues.length, path: outputPath }));
      return;
    }
    new Notice(this.t("notice.validationOk", { path: outputPath }));
  }

  private async validateMarkdownExport(markdown: string, sourcePath: string): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (/^---\s*\n[\s\S]*?\n---/.test(markdown) && !this.settings.htmlExcludeFrontmatter) {
      issues.push({ severity: "warning", sourcePath, message: "Frontmatter will be included in the exported HTML." });
    }
    for (const match of markdown.matchAll(/!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      if (!this.app.metadataCache.getFirstLinkpathDest(match[1], sourcePath)) {
        issues.push({ severity: "error", sourcePath, message: `Broken internal link: ${match[1]}` });
      }
    }
    for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/[?#].*$/, "").replace(/^<|>$/g, "");
      if (/^https?:\/\//i.test(target)) {
        issues.push({ severity: "warning", sourcePath, message: `External image reference: ${target}` });
      } else if (!this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)) {
        issues.push({ severity: "error", sourcePath, message: `Missing image asset: ${target}` });
      }
    }
    const svgFiles = this.getSvgFilesFromMarkdown(markdown, sourcePath);
    for (const file of svgFiles) {
      try {
        for (const warning of this.getSvgExportWarnings(await this.app.vault.read(file), this.settings.imageFormat)) {
          issues.push({ severity: "warning", sourcePath: file.path, message: warning });
        }
      } catch (error) {
        issues.push({ severity: "error", sourcePath: file.path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return issues;
  }

  private async writeValidationReport(sourcePath: string, issues: ValidationIssue[]): Promise<string> {
    await this.ensureFolder(this.settings.htmlOutputFolder);
    const now = new Date();
    const filename = `export-validation-${this.formatDate(now)}-${this.formatTime(now)}.md`;
    const outputPath = await this.nextAvailablePath(this.settings.htmlOutputFolder, filename);
    const lines = [
      "# Export validation report",
      "",
      `- Source: ${sourcePath}`,
      `- Created: ${now.toISOString()}`,
      `- Issues: ${issues.length}`,
      "",
      "| Severity | Source | Message |",
      "|---|---|---|",
      ...(issues.length ? issues.map((issue) => `| ${issue.severity} | ${this.escapeMarkdownTableCell(issue.sourcePath)} | ${this.escapeMarkdownTableCell(issue.message)} |`) : ["| OK |  | No export issues found. |"]),
      "",
    ];
    await this.app.vault.adapter.write(outputPath, lines.join("\n"));
    await this.recordSavedFile({ filename, vaultPath: outputPath }, "report", this.t("action.validationReport"));
    return outputPath;
  }

  async exportSettingsJson() {
    await this.ensureFolder(this.settings.htmlOutputFolder);
    const now = new Date();
    const filename = `owen-exporter-settings-${this.formatDate(now)}-${this.formatTime(now)}.json`;
    const outputPath = await this.nextAvailablePath(this.settings.htmlOutputFolder, filename);
    const payload: ExporterSettingsFile = {
      version: 1,
      settings: this.settings,
    };
    await this.app.vault.adapter.write(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    await this.recordSavedFile({ filename, vaultPath: outputPath }, "report", this.t("action.settingsBackup"));
    new Notice(this.t("notice.settingsExported", { path: outputPath }));
  }

  async importSettingsJsonFromClipboard() {
    const text = await navigator.clipboard.readText();
    let payload: ExporterSettingsFile;
    try {
      payload = JSON.parse(text) as ExporterSettingsFile;
    } catch {
      new Notice(this.t("notice.invalidJson"));
      return;
    }
    if (!payload || typeof payload !== "object" || !payload.settings || typeof payload.settings !== "object") {
      new Notice(this.t("notice.invalidBackup"));
      return;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, payload.settings, { language: normalizeLocalePreference(payload.settings.language) });
    await this.saveSettings();
    this.refreshCommandNames();
    new Notice(this.t("notice.settingsImported"));
  }

  private async exportCurrentNoteSvgs(view: MarkdownView) {
    if (!view.file) {
      return;
    }

    const markdown = await this.app.vault.read(view.file);
    const files = this.getSvgFilesFromMarkdown(markdown, view.file.path);
    if (!files.length) {
      new Notice(this.t("notice.noSvgs"));
      return;
    }

    let savedCount = 0;
    const results: SvgBatchResult[] = [];
    const format = this.settings.imageFormat;
    const extension = format === "jpeg" ? "jpg" : "png";
    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

    for (const [index, file] of files.entries()) {
      try {
        const svgText = this.ensureSvgNamespace(await this.app.vault.read(file));
        const raster = await this.rasterizeSvg(svgText, format);
        const filename = this.buildImageFilename(this.basename(file.path), format, extension, {
          sourcePath: view.file.path,
          index: index + 1,
        });
        const blob = new Blob([raster], { type: mimeType });
        const outputPath = await this.saveImageBlobToVault(blob, filename);
        await this.recordSavedFile({ filename, vaultPath: outputPath }, "image-save", this.t("action.batchSvg", { index: index + 1 }));
        results.push({ index: index + 1, sourcePath: file.path, outputPath });
        savedCount += 1;
      } catch (error) {
        results.push({ index: index + 1, sourcePath: file.path, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const failures = results.filter((result) => result.error);
    const reportPath = await this.maybeWriteSvgBatchReport(view.file.path, results);
    if (failures.length) {
      console.warn("Owen Exporter SVG batch export failures", failures);
      new Notice(this.t("notice.svgBatchPartial", { saved: savedCount, total: files.length, suffix: reportPath ? this.t("notice.reportSuffix", { path: reportPath }) : this.t("notice.consoleSuffix") }));
      return;
    }

    new Notice(this.t("notice.svgBatchSuccess", { saved: savedCount, folder: normalizeVaultFolder(this.settings.imageOutputFolder) || this.t("common.vaultRoot"), suffix: reportPath ? this.t("notice.reportSuffix", { path: reportPath }) : "" }));
  }

  private async diagnoseCurrentNoteSvgs(view: MarkdownView) {
    if (!view.file) {
      return;
    }

    const markdown = await this.app.vault.read(view.file);
    const files = this.getSvgFilesFromMarkdown(markdown, view.file.path);
    if (!files.length) {
      new Notice(this.t("notice.noSvgs"));
      return;
    }

    const results: SvgBatchResult[] = [];
    for (const [index, file] of files.entries()) {
      try {
        const svgText = this.ensureSvgNamespace(await this.app.vault.read(file));
        const warnings = this.getSvgExportWarnings(svgText, this.settings.imageFormat);
        results.push({ index: index + 1, sourcePath: file.path, error: warnings.join("; ") || undefined });
      } catch (error) {
        results.push({ index: index + 1, sourcePath: file.path, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const warnings = results.filter((result) => result.error);
    if (warnings.length) {
      console.warn("Owen Exporter SVG diagnostics", warnings);
      new Notice(this.t("notice.svgAttention", { warnings: warnings.length, total: results.length }));
      return;
    }
    new Notice(this.t("notice.svgReadyAll", { total: results.length }));
  }

  private async maybeWriteSvgBatchReport(sourceNotePath: string, results: SvgBatchResult[]): Promise<string | null> {
    const hasFailures = results.some((result) => result.error);
    if (this.settings.svgBatchReportMode === "never" || (this.settings.svgBatchReportMode === "on-failure" && !hasFailures)) {
      return null;
    }

    await this.ensureFolder(this.settings.imageOutputFolder);
    const now = new Date();
    const filename = `svg-export-report-${this.formatDate(now)}-${this.formatTime(now)}.md`;
    const outputPath = await this.nextAvailablePath(this.settings.imageOutputFolder, filename);
    const lines = [
      `# SVG export report`,
      "",
      `- Source note: ${sourceNotePath}`,
      `- Created: ${now.toISOString()}`,
      `- Total: ${results.length}`,
      `- Succeeded: ${results.filter((result) => result.outputPath).length}`,
      `- Failed: ${results.filter((result) => result.error).length}`,
      "",
      "| # | Source | Output | Status |",
      "|---:|---|---|---|",
      ...results.map((result) => `| ${result.index} | ${this.escapeMarkdownTableCell(result.sourcePath)} | ${this.escapeMarkdownTableCell(result.outputPath ?? "")} | ${this.escapeMarkdownTableCell(result.error ?? "OK")} |`),
      "",
    ];
    await this.app.vault.adapter.write(outputPath, lines.join("\n"));
    await this.recordSavedFile({ filename, vaultPath: outputPath }, "report", this.t("action.svgReport"));
    return outputPath;
  }

  private escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  }

  private getSvgFilesFromMarkdown(markdown: string, sourcePath: string): TFile[] {
    const links = new Set<string>();
    const files: TFile[] = [];
    const addLink = (rawLink: string) => {
      const link = this.cleanSvgLink(rawLink);
      if (!link || links.has(link)) {
        return;
      }
      const file = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
      if (file instanceof TFile && file.extension.toLowerCase() === "svg") {
        links.add(link);
        files.push(file);
      }
    };

    for (const match of markdown.matchAll(/!\[\[([^\]|#]+\.svg)(?:[#|][^\]]*)?\]\]/gi)) {
      addLink(match[1]);
    }
    for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)]+\.svg(?:[?#][^)]*)?)\)/gi)) {
      addLink(match[1]);
    }

    return files;
  }

  private cleanSvgLink(rawLink: string): string | null {
    const link = rawLink.trim().replace(/^<|>$/g, "");
    if (/^[a-z]+:\/\//i.test(link)) {
      return null;
    }
    const withoutQuery = link.replace(/[?#].*$/, "");
    try {
      return decodeURIComponent(withoutQuery);
    } catch {
      return withoutQuery;
    }
  }

  private getActiveSourcePath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path ?? null;
  }

  private basename(path: string): string {
    return path.split("/").pop()?.replace(/\.[^.]+$/, "") || "export";
  }

  private slugify(value: string): string {
    return slugifyExportName(value);
  }

  private getFilenameTokens(name: string, format: string, options: FilenameTokenOptions = {}): Record<string, string | number> {
    const now = new Date();
    const sourcePath = options.sourcePath ?? "";
    const folderPath = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
    const folderName = folderPath ? folderPath.split("/").pop() ?? "vault" : "vault";
    const noteName = sourcePath ? this.basename(sourcePath) : name;
    return {
      name: this.slugify(name),
      rawName: name,
      note: this.slugify(noteName),
      rawNote: noteName,
      folder: this.slugify(folderName),
      rawFolder: folderName,
      heading: this.slugify(options.heading ?? name),
      rawHeading: options.heading ?? name,
      index: options.index ?? "",
      format,
      scale: this.getImageScale(),
      date: this.formatDate(now),
      time: this.formatTime(now),
    };
  }

  private renderTextTemplate(template: string, tokens: Record<string, string | number>, fallback: string): string {
    const rendered = (template.trim() || fallback).replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, key: string) => {
      const value = tokens[key];
      return value === undefined ? "" : String(value);
    });
    return rendered.trim() || fallback;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private formatTime(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${hours}-${minutes}-${seconds}`;
  }

  private async ensureFolder(folder: string) {
    const normalized = normalizePath(normalizeVaultFolder(folder));
    if (!normalized) {
      return;
    }

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async nextAvailablePath(folder: string, filename: string): Promise<string> {
    return normalizePath(await nextAvailableVaultPath(folder, filename, (path) => this.app.vault.adapter.exists(normalizePath(path))));
  }
}

class HtmlPreviewModal extends Modal {
  private options: HtmlPreviewOptions;

  constructor(app: App, private t: Translator, options: HtmlPreviewOptions) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-html-preview-modal");
    contentEl.createEl("h2", { text: this.options.title });

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText(this.t("preview.copyHtml"))
          .setIcon("copy")
          .onClick(async () => {
            await this.runAction(this.options.onCopy);
          });
      })
      .addButton((button) => {
        button
          .setButtonText(this.t("preview.saveHtml"))
          .setIcon("file-down")
          .setCta()
          .onClick(async () => {
            await this.runAction(this.options.onSave);
          });
      });

    const frame = contentEl.createDiv({ cls: "owen-exporter-html-preview-frame" });
    const preview = frame.createDiv({ cls: "owen-exporter-html-preview-content" });
    preview.addClass("markdown-preview-view");
    preview.addClass("markdown-rendered");
    preview.appendChild(sanitizeHTMLToDom(this.options.html));
  }

  onClose() {
    this.contentEl.empty();
  }

  private async runAction(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      console.error(error);
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
}

class SvgPreviewModal extends Modal {
  private options: SvgPreviewOptions;
  private objectUrl: string | null = null;

  constructor(app: App, private t: Translator, options: SvgPreviewOptions) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-svg-preview-modal");
    contentEl.createEl("h2", { text: this.t("preview.svgTitle") });

    const meta = contentEl.createDiv({ cls: "owen-exporter-preview-meta" });
    this.addMeta(meta, this.t("preview.filename"), this.options.filename);
    this.addMeta(meta, this.t("preview.sourceSize"), `${Math.round(this.options.dimensions.width)} x ${Math.round(this.options.dimensions.height)}`);
    this.addMeta(meta, this.t("preview.outputSize"), `${this.options.outputWidth} x ${this.options.outputHeight}`);
    this.addMeta(meta, this.t("preview.format"), this.options.format.toUpperCase());
    this.addMeta(meta, this.t("preview.background"), this.options.background || this.t("common.transparent"));

    if (this.options.warnings.length) {
      const warningList = contentEl.createDiv({ cls: "owen-exporter-preview-warnings" });
      for (const warning of this.options.warnings) {
        warningList.createDiv({ text: warning });
      }
    }

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText(this.t("preview.exportPng"))
          .setIcon("image-down")
          .onClick(async () => this.runExport("png"));
      })
      .addButton((button) => {
        button
          .setButtonText(this.t("preview.exportJpeg"))
          .setIcon("image")
          .onClick(async () => this.runExport("jpeg"));
      });

    const frame = contentEl.createDiv({ cls: "owen-exporter-svg-preview-frame" });
    this.objectUrl = URL.createObjectURL(new Blob([this.options.svgText], { type: "image/svg+xml;charset=utf-8" }));
    const image = frame.createEl("img", { attr: { src: this.objectUrl, alt: this.options.baseName } });
    image.addClass("owen-exporter-svg-preview-image");
  }

  onClose() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.contentEl.empty();
  }

  private addMeta(parent: HTMLElement, label: string, value: string) {
    const item = parent.createDiv({ cls: "owen-exporter-preview-meta-item" });
    item.createSpan({ text: label });
    item.createEl("strong", { text: value });
  }

  private async runExport(format: ExportImageFormat) {
    try {
      await this.options.onExport(format);
    } catch (error) {
      console.error(error);
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
}

class ExportHistoryModal extends Modal {
  private entries: RecentExportEntry[];
  private actions: ExportHistoryActions;

  constructor(app: App, private t: Translator, private locale: Locale, entries: RecentExportEntry[], actions: ExportHistoryActions) {
    super(app);
    this.entries = entries;
    this.actions = actions;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-history-modal");
    contentEl.createEl("h2", { text: this.t("history.title") });

    if (!this.entries.length) {
      contentEl.createDiv({ cls: "owen-exporter-empty-state", text: this.t("history.empty") });
      return;
    }

    new Setting(contentEl).addButton((button) => {
      button
        .setButtonText(this.t("history.clear"))
        .setIcon("trash")
        .onClick(() => {
          this.actions.clear();
          this.close();
        });
    });

    const list = contentEl.createDiv({ cls: "owen-exporter-history-list" });
    for (const entry of this.entries) {
      const row = list.createDiv({ cls: "owen-exporter-history-row" });
      const text = row.createDiv({ cls: "owen-exporter-history-text" });
      text.createEl("strong", { text: entry.label });
      text.createDiv({ text: entry.vaultPath ?? entry.systemPath ?? entry.filename });
      text.createDiv({ cls: "owen-exporter-history-date", text: new Date(entry.createdAt).toLocaleString(this.locale) });

      const actions = row.createDiv({ cls: "owen-exporter-history-actions" });
      this.addActionButton(actions, this.t("common.open"), "external-link", () => this.actions.open(entry));
      this.addActionButton(actions, this.t("common.reveal"), "folder-open", () => this.actions.reveal(entry));
      this.addActionButton(actions, this.t("common.copyPath"), "copy", () => this.actions.copyPath(entry));
    }
  }

  onClose() {
    this.contentEl.empty();
  }

  private addActionButton(parent: HTMLElement, label: string, icon: string, action: () => Promise<void>) {
    const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    button.addEventListener("click", () => {
      void action();
    });
  }
}

class ExportJobModal extends Modal {
  onCancel: (() => void) | null = null;
  private entries: ExportJobEntry[];
  private listEl: HTMLElement | null = null;

  constructor(app: App, private t: Translator, private title: string, labels: string[]) {
    super(app);
    this.entries = labels.map((label) => ({ label, status: "pending" }));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-job-modal");
    contentEl.createEl("h2", { text: this.title });
    new Setting(contentEl).addButton((button) => {
      button
        .setButtonText(this.t("common.cancel"))
        .setIcon("x")
        .onClick(() => {
          this.onCancel?.();
          new Notice(this.t("notice.jobStopping"));
        });
    });
    this.listEl = contentEl.createDiv({ cls: "owen-exporter-job-list" });
    this.renderEntries();
  }

  onClose() {
    this.contentEl.empty();
  }

  updateEntry(index: number, status: ExportJobStatus, detail?: string) {
    const entry = this.entries[index];
    if (!entry) {
      return;
    }
    entry.status = status;
    entry.detail = detail;
    this.renderEntries();
  }

  private renderEntries() {
    if (!this.listEl) {
      return;
    }
    this.listEl.empty();
    for (const entry of this.entries) {
      const row = this.listEl.createDiv({ cls: `owen-exporter-job-row is-${entry.status}` });
      row.createEl("strong", { text: entry.label });
      row.createSpan({ text: entry.detail ?? this.t(`common.status.${entry.status}` as TranslationKey) });
    }
  }
}

class HtmlCompareModal extends Modal {
  constructor(app: App, private title: string, private panes: Array<{ label: string; html: string }>) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-compare-modal");
    contentEl.createEl("h2", { text: this.title });
    const grid = contentEl.createDiv({ cls: "owen-exporter-compare-grid" });
    for (const pane of this.panes) {
      const column = grid.createDiv({ cls: "owen-exporter-compare-pane" });
      column.createEl("h3", { text: pane.label });
      const content = column.createDiv({ cls: "owen-exporter-compare-content" });
      content.addClass("markdown-preview-view");
      content.addClass("markdown-rendered");
      content.appendChild(sanitizeHTMLToDom(pane.html));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ProfileSwitcherModal extends Modal {
  constructor(app: App, private t: Translator, private profiles: Array<{ name: string; label: string }>, private onApply: (name: string) => Promise<void>) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-profile-switcher-modal");
    contentEl.createEl("h2", { text: this.t("profile.title") });
    const list = contentEl.createDiv({ cls: "owen-exporter-profile-list" });
    for (const profile of this.profiles) {
      const row = list.createDiv({ cls: "owen-exporter-profile-row" });
      row.createEl("strong", { text: profile.label });
      const button = row.createEl("button", { text: this.t("profile.use") });
      button.addEventListener("click", () => {
        void this.onApply(profile.name).then(() => this.close());
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class OwenExporterSettingTab extends PluginSettingTab {
  plugin: OwenExporterPlugin;

  constructor(app: App, plugin: OwenExporterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.renderSettings();
  }

  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("owen-exporter-settings");

    const settingsRoot = containerEl.createDiv({ cls: "owen-exporter-settings-root" });
    const interfaceGroup = this.createSettingsGroup(
      settingsRoot,
      this.plugin.t("settings.group.interface"),
      this.plugin.t("settings.group.interfaceDesc"),
      "languages",
    );
    new Setting(interfaceGroup)
      .setName(this.plugin.t("language.name"))
      .setDesc(this.plugin.t("language.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("auto", this.plugin.t("language.auto"))
          .addOption("en", this.plugin.t("language.en"))
          .addOption("ko", this.plugin.t("language.ko"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value: LocalePreference) => {
            this.plugin.settings.language = normalizeLocalePreference(value);
            await this.plugin.saveSettings();
            this.plugin.refreshCommandNames();
            this.renderSettings();
          });
      });
    const imageGroup = this.createSettingsGroup(
      settingsRoot,
      this.plugin.t("settings.group.image"),
      this.plugin.t("settings.group.imageDesc"),
      "image-down",
    );
    const htmlGroup = this.createSettingsGroup(
      settingsRoot,
      this.plugin.t("settings.group.html"),
      this.plugin.t("settings.group.htmlDesc"),
      "file-code",
    );
    const workflowGroup = this.createSettingsGroup(
      settingsRoot,
      this.plugin.t("settings.group.workflow"),
      this.plugin.t("settings.group.workflowDesc"),
      "workflow",
    );
    const backupGroup = this.createSettingsGroup(
      settingsRoot,
      this.plugin.t("settings.group.backup"),
      this.plugin.t("settings.group.backupDesc"),
      "archive-restore",
    );

    new Setting(imageGroup)
      .setName(this.plugin.t("settings.imageFormat.name"))
      .setDesc(this.plugin.t("settings.imageFormat.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("png", "PNG")
          .addOption("jpeg", "JPEG")
          .setValue(this.plugin.settings.imageFormat)
          .onChange(async (value: ExportImageFormat) => {
            this.plugin.settings.imageFormat = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName(this.plugin.t("settings.imageSave.name"))
      .setDesc(this.plugin.t("settings.imageSave.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("dialog", this.plugin.t("settings.imageSave.dialog"))
          .addOption("vault", this.plugin.t("settings.imageSave.vault"))
          .setValue(this.plugin.settings.imageSaveMode)
          .onChange(async (value: ImageSaveMode) => {
            this.plugin.settings.imageSaveMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName(this.plugin.t("settings.imageFolder.name"))
      .setDesc(this.plugin.t("settings.imageFolder.desc"))
      .addText((text) => {
        text
          .setPlaceholder("exports/images")
          .setValue(this.plugin.settings.imageOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.imageOutputFolder = value.trim() || DEFAULT_SETTINGS.imageOutputFolder;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName(this.plugin.t("settings.batchReport.name"))
      .setDesc(this.plugin.t("settings.batchReport.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("on-failure", this.plugin.t("settings.batchReport.failure"))
          .addOption("always", this.plugin.t("common.always"))
          .addOption("never", this.plugin.t("common.never"))
          .setValue(this.plugin.settings.svgBatchReportMode)
          .onChange(async (value: SvgBatchReportMode) => {
            this.plugin.settings.svgBatchReportMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName(this.plugin.t("settings.imageFilename.name"))
      .setDesc(this.plugin.t("settings.imageFilename.desc", { tokens: "{{name}}, {{rawName}}, {{note}}, {{folder}}, {{heading}}, {{index}}, {{format}}, {{scale}}, {{date}}, {{time}}" }))
      .addText((text) => {
        text
          .setPlaceholder("{{name}}")
          .setValue(this.plugin.settings.imageFilenameTemplate)
          .onChange(async (value) => {
            this.plugin.settings.imageFilenameTemplate = value.trim() || DEFAULT_SETTINGS.imageFilenameTemplate;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName(this.plugin.t("settings.imageQuality.name"))
      .setDesc(this.plugin.t("settings.imageQuality.desc"))
      .addSlider((slider) => {
        slider
          .setLimits(0.1, 1, 0.01)
          .setValue(this.plugin.settings.imageQuality)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.imageQuality = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName(this.plugin.t("settings.imageScale.name"))
      .setDesc(this.plugin.t("settings.imageScale.desc"))
      .addSlider((slider) => {
        slider
          .setLimits(1, 4, 0.25)
          .setValue(this.plugin.settings.imageScale)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.imageScale = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName(this.plugin.t("settings.imageBackground.name"))
      .setDesc(this.plugin.t("settings.imageBackground.desc"))
      .addText((text) => {
        text
          .setPlaceholder("#FFFFFF")
          .setValue(this.plugin.settings.imageBackground)
          .onChange(async (value) => {
            this.plugin.settings.imageBackground = value.trim() || "#FFFFFF";
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.htmlProfile.name"))
      .setDesc(this.plugin.t("settings.htmlProfile.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("custom", this.plugin.t("common.custom"))
          .addOption("obsidian-document", this.plugin.t("profile.obsidian"))
          .addOption("portable-document", this.plugin.t("profile.portable"))
          .addOption("clean-fragment", this.plugin.t("profile.clean"))
          .setValue(this.plugin.settings.htmlExportProfile)
          .onChange(async (value: HtmlExportProfile) => {
            await this.applyHtmlProfile(value);
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.htmlFolder.name"))
      .setDesc(this.plugin.t("settings.htmlFolder.desc"))
      .addText((text) => {
        text
          .setPlaceholder("exports/html")
          .setValue(this.plugin.settings.htmlOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.htmlOutputFolder = value.trim() || DEFAULT_SETTINGS.htmlOutputFolder;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.htmlFilename.name"))
      .setDesc(this.plugin.t("settings.htmlFilename.desc", { tokens: "{{name}}, {{rawName}}, {{note}}, {{folder}}, {{heading}}, {{index}}, {{format}}, {{date}}, {{time}}" }))
      .addText((text) => {
        text
          .setPlaceholder("{{name}}")
          .setValue(this.plugin.settings.htmlFilenameTemplate)
          .onChange(async (value) => {
            this.plugin.settings.htmlFilenameTemplate = value.trim() || DEFAULT_SETTINGS.htmlFilenameTemplate;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.htmlSave.name"))
      .setDesc(this.plugin.t("settings.htmlSave.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("document", this.plugin.t("settings.htmlSave.document"))
          .addOption("fragment", this.plugin.t("settings.htmlSave.fragment"))
          .setValue(this.plugin.settings.htmlSaveMode)
          .onChange(async (value: HtmlSaveMode) => {
            this.markCustomHtmlProfile();
            this.plugin.settings.htmlSaveMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.htmlStyle.name"))
      .setDesc(this.plugin.t("settings.htmlStyle.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("obsidian", this.plugin.t("settings.htmlStyle.obsidian"))
          .addOption("portable", this.plugin.t("settings.htmlStyle.portable"))
          .addOption("clean", this.plugin.t("settings.htmlStyle.clean"))
          .setValue(this.plugin.settings.htmlStyleMode)
          .onChange(async (value: HtmlStyleMode) => {
            this.markCustomHtmlProfile();
            this.plugin.settings.htmlStyleMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.clipboard.name"))
      .setDesc(this.plugin.t("settings.clipboard.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("html-and-text", this.plugin.t("settings.clipboard.both"))
          .addOption("html", this.plugin.t("settings.clipboard.html"))
          .addOption("text", this.plugin.t("settings.clipboard.text"))
          .setValue(this.plugin.settings.htmlClipboardMode)
          .onChange(async (value: HtmlClipboardMode) => {
            this.plugin.settings.htmlClipboardMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.documentTitle.name"))
      .setDesc(this.plugin.t("settings.documentTitle.desc"))
      .addText((text) => {
        text
          .setPlaceholder("{{name}} export")
          .setValue(this.plugin.settings.htmlDocumentTitle)
          .onChange(async (value) => {
            this.markCustomHtmlProfile();
            this.plugin.settings.htmlDocumentTitle = value.trim() || DEFAULT_SETTINGS.htmlDocumentTitle;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.frontmatter.name"))
      .setDesc(this.plugin.t("settings.frontmatter.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.htmlExcludeFrontmatter)
          .onChange(async (value) => {
            this.plugin.settings.htmlExcludeFrontmatter = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.headingIds.name"))
      .setDesc(this.plugin.t("settings.headingIds.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.htmlPreserveHeadingIds)
          .onChange(async (value) => {
            this.plugin.settings.htmlPreserveHeadingIds = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.callouts.name"))
      .setDesc(this.plugin.t("settings.callouts.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.htmlPreserveCalloutClasses)
          .onChange(async (value) => {
            this.plugin.settings.htmlPreserveCalloutClasses = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.internalLinks.name"))
      .setDesc(this.plugin.t("settings.internalLinks.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.htmlConvertInternalLinksToObsidianUris)
          .onChange(async (value) => {
            this.plugin.settings.htmlConvertInternalLinksToObsidianUris = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.assets.name"))
      .setDesc(this.plugin.t("settings.assets.desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("keep", this.plugin.t("settings.assets.keep"))
          .addOption("relative", this.plugin.t("settings.assets.relative"))
          .addOption("copy", this.plugin.t("settings.assets.copy"))
          .addOption("base64", this.plugin.t("settings.assets.base64"))
          .setValue(this.plugin.settings.htmlAssetMode)
          .onChange(async (value: HtmlAssetMode) => {
            this.plugin.settings.htmlAssetMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.assetFolder.name"))
      .setDesc(this.plugin.t("settings.assetFolder.desc"))
      .addText((text) => {
        text
          .setPlaceholder("exports/html/assets")
          .setValue(this.plugin.settings.htmlAssetOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.htmlAssetOutputFolder = value.trim() || DEFAULT_SETTINGS.htmlAssetOutputFolder;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName(this.plugin.t("settings.documentTemplate.name"))
      .setDesc(this.plugin.t("settings.documentTemplate.desc", { tokens: "{{title}}, {{content}}, {{sourcePath}}, {{style}}" }))
      .addTextArea((text) => {
        text
          .setPlaceholder("<!doctype html>...{{content}}...")
          .setValue(this.plugin.settings.htmlDocumentTemplate)
          .onChange(async (value) => {
            this.markCustomHtmlProfile();
            this.plugin.settings.htmlDocumentTemplate = value;
            await this.plugin.saveSettings();
          });
      });

    let profileName = "";
    new Setting(workflowGroup)
      .setName(this.plugin.t("settings.quickProfile.name"))
      .setDesc(this.plugin.t("settings.quickProfile.desc"))
      .addButton((button) => {
        button
          .setButtonText(this.plugin.t("settings.quickProfile.button"))
          .setIcon("list-filter")
          .onClick(() => this.plugin.openHtmlProfileSwitcher());
      });

    new Setting(workflowGroup)
      .setName(this.plugin.t("settings.manifest.name"))
      .setDesc(this.plugin.t("settings.manifest.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.writeExportManifest)
          .onChange(async (value) => {
            this.plugin.settings.writeExportManifest = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(workflowGroup)
      .setName(this.plugin.t("settings.saveProfile.name"))
      .setDesc(this.plugin.t("settings.saveProfile.desc"))
      .addText((text) => {
        text
          .setPlaceholder(this.plugin.t("settings.saveProfile.placeholder"))
          .onChange((value) => {
            profileName = value.trim();
          });
      })
      .addButton((button) => {
        button
          .setButtonText(this.plugin.t("settings.saveProfile.button"))
          .setIcon("save")
          .onClick(async () => {
            await this.saveCurrentHtmlProfile(profileName);
          });
      });

    if (this.plugin.settings.htmlCustomProfiles.length) {
      new Setting(workflowGroup)
        .setName(this.plugin.t("settings.applyProfile.name"))
        .setDesc(this.plugin.t("settings.applyProfile.desc"))
        .addDropdown((dropdown) => {
          for (const profile of this.plugin.settings.htmlCustomProfiles) {
            dropdown.addOption(profile.name, profile.name);
          }
          dropdown.onChange(async (value) => {
            await this.applyCustomHtmlProfile(value);
          });
        })
        .addButton((button) => {
          button
            .setButtonText(this.plugin.t("common.delete"))
            .setIcon("trash")
            .onClick(async () => {
              const name = activeWindow.prompt(this.plugin.t("settings.deleteProfile.prompt"));
              if (name) {
                await this.deleteCustomHtmlProfile(name.trim());
              }
            });
        });
    }

    new Setting(workflowGroup)
      .setName(this.plugin.t("settings.openAfter.name"))
      .setDesc(this.plugin.t("settings.openAfter.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.afterExportOpenFile)
          .onChange(async (value) => {
            this.plugin.settings.afterExportOpenFile = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(workflowGroup)
      .setName(this.plugin.t("settings.revealAfter.name"))
      .setDesc(this.plugin.t("settings.revealAfter.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.afterExportRevealFile)
          .onChange(async (value) => {
            this.plugin.settings.afterExportRevealFile = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(workflowGroup)
      .setName(this.plugin.t("settings.copyAfter.name"))
      .setDesc(this.plugin.t("settings.copyAfter.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.afterExportCopyPath)
          .onChange(async (value) => {
            this.plugin.settings.afterExportCopyPath = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(workflowGroup)
      .setName(this.plugin.t("settings.insertLink.name"))
      .setDesc(this.plugin.t("settings.insertLink.desc"))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.afterImageExportInsertMarkdownLink)
          .onChange(async (value) => {
            this.plugin.settings.afterImageExportInsertMarkdownLink = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(backupGroup)
      .setName(this.plugin.t("settings.backup.name"))
      .setDesc(this.plugin.t("settings.backup.desc"))
      .addButton((button) => {
        button
          .setButtonText(this.plugin.t("common.export"))
          .setIcon("download")
          .onClick(() => void this.plugin.exportSettingsJson());
      })
      .addButton((button) => {
        button
          .setButtonText(this.plugin.t("settings.backup.import"))
          .setIcon("clipboard")
          .onClick(async () => {
            await this.plugin.importSettingsJsonFromClipboard();
            this.renderSettings();
          });
      });
  }

  private createSettingsGroup(parent: HTMLElement, title: string, description: string, icon: string): HTMLElement {
    const group = parent.createDiv({ cls: "owen-exporter-settings-group" });
    const header = group.createDiv({ cls: "owen-exporter-settings-group-header" });
    const heading = new Setting(header)
      .setName(title)
      .setDesc(description)
      .setHeading();
    heading.settingEl.dataset.owenSection = icon;
    const glyph = heading.settingEl.createDiv({ cls: "owen-exporter-settings-section-glyph" });
    glyph.setAttr("aria-hidden", "true");
    setIcon(glyph, icon);
    heading.settingEl.insertBefore(glyph, heading.infoEl);

    return group.createDiv({ cls: "owen-exporter-settings-group-body" });
  }

  private async applyHtmlProfile(profile: HtmlExportProfile) {
    this.plugin.settings.htmlExportProfile = profile;
    if (profile !== "custom") {
      Object.assign(this.plugin.settings, HTML_EXPORT_PROFILES[profile]);
    }
    await this.plugin.saveSettings();
    this.renderSettings();
  }

  private async saveCurrentHtmlProfile(name: string) {
    if (!name) {
      new Notice(this.plugin.t("notice.profileNameRequired"));
      return;
    }
    const profile: HtmlCustomProfile = {
      name,
      htmlOutputFolder: this.plugin.settings.htmlOutputFolder,
      htmlFilenameTemplate: this.plugin.settings.htmlFilenameTemplate,
      htmlSaveMode: this.plugin.settings.htmlSaveMode,
      htmlStyleMode: this.plugin.settings.htmlStyleMode,
      htmlClipboardMode: this.plugin.settings.htmlClipboardMode,
      htmlDocumentTitle: this.plugin.settings.htmlDocumentTitle,
      htmlExcludeFrontmatter: this.plugin.settings.htmlExcludeFrontmatter,
      htmlPreserveHeadingIds: this.plugin.settings.htmlPreserveHeadingIds,
      htmlPreserveCalloutClasses: this.plugin.settings.htmlPreserveCalloutClasses,
      htmlConvertInternalLinksToObsidianUris: this.plugin.settings.htmlConvertInternalLinksToObsidianUris,
      htmlAssetMode: this.plugin.settings.htmlAssetMode,
      htmlAssetOutputFolder: this.plugin.settings.htmlAssetOutputFolder,
      htmlDocumentTemplate: this.plugin.settings.htmlDocumentTemplate,
    };
    const profiles = this.plugin.settings.htmlCustomProfiles.filter((existing) => existing.name !== name);
    profiles.push(profile);
    this.plugin.settings.htmlCustomProfiles = profiles;
    await this.plugin.saveSettings();
    new Notice(this.plugin.t("notice.profileSaved", { name }));
    this.renderSettings();
  }

  private async applyCustomHtmlProfile(name: string) {
    const profile = this.plugin.settings.htmlCustomProfiles.find((candidate) => candidate.name === name);
    if (!profile) {
      return;
    }
    Object.assign(this.plugin.settings, {
      htmlExportProfile: "custom",
      htmlOutputFolder: profile.htmlOutputFolder,
      htmlFilenameTemplate: profile.htmlFilenameTemplate,
      htmlSaveMode: profile.htmlSaveMode,
      htmlStyleMode: profile.htmlStyleMode,
      htmlClipboardMode: profile.htmlClipboardMode,
      htmlDocumentTitle: profile.htmlDocumentTitle,
      htmlExcludeFrontmatter: profile.htmlExcludeFrontmatter ?? DEFAULT_SETTINGS.htmlExcludeFrontmatter,
      htmlPreserveHeadingIds: profile.htmlPreserveHeadingIds ?? DEFAULT_SETTINGS.htmlPreserveHeadingIds,
      htmlPreserveCalloutClasses: profile.htmlPreserveCalloutClasses ?? DEFAULT_SETTINGS.htmlPreserveCalloutClasses,
      htmlConvertInternalLinksToObsidianUris: profile.htmlConvertInternalLinksToObsidianUris ?? DEFAULT_SETTINGS.htmlConvertInternalLinksToObsidianUris,
      htmlAssetMode: profile.htmlAssetMode ?? DEFAULT_SETTINGS.htmlAssetMode,
      htmlAssetOutputFolder: profile.htmlAssetOutputFolder ?? DEFAULT_SETTINGS.htmlAssetOutputFolder,
      htmlDocumentTemplate: profile.htmlDocumentTemplate ?? DEFAULT_SETTINGS.htmlDocumentTemplate,
    });
    await this.plugin.saveSettings();
    new Notice(this.plugin.t("notice.profileApplied", { name }));
    this.renderSettings();
  }

  private async deleteCustomHtmlProfile(name: string) {
    const before = this.plugin.settings.htmlCustomProfiles.length;
    this.plugin.settings.htmlCustomProfiles = this.plugin.settings.htmlCustomProfiles.filter((profile) => profile.name !== name);
    if (this.plugin.settings.htmlCustomProfiles.length === before) {
      new Notice(this.plugin.t("notice.profileMissing", { name }));
      return;
    }
    await this.plugin.saveSettings();
    new Notice(this.plugin.t("notice.profileDeleted", { name }));
    this.renderSettings();
  }

  private markCustomHtmlProfile() {
    this.plugin.settings.htmlExportProfile = "custom";
  }
}
