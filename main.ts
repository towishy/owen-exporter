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
  private lastExportAction: LastExportAction | null = null;
  private lastExportResult: LastExportResult | null = null;
  private recentExports: RecentExportEntry[] = [];

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new OwenExporterSettingTab(this.app, this));

    this.addCommand({
      id: "copy-selected-markdown-as-html",
      name: "Copy selected Markdown as HTML",
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
      name: "Preview selected Markdown as HTML",
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
      name: "Compare selected Markdown HTML styles",
      editorCheckCallback: (checking, editor, view) => {
        const selection = editor.getSelection();
        if (!selection.trim()) {
          return false;
        }
        if (!checking) {
          void this.compareMarkdownHtmlStyles(selection, view.file?.path ?? "", "Selection style comparison");
        }
        return true;
      },
    });

    this.addCommand({
      id: "save-selected-markdown-as-html",
      name: "Save selected Markdown as HTML file",
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
      name: "Preview current note as HTML",
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
      name: "Compare current note HTML styles",
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
      name: "Save current note as HTML file",
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
      name: "Export current folder notes as HTML",
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
      name: "Export changed current folder notes as HTML",
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
      name: "Export linked notes as HTML",
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
      name: "Export changed linked notes as HTML",
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
      name: "Validate current note export",
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
      name: "Export all SVG embeds in current note",
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
      name: "Diagnose SVG embeds in current note",
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
      name: "Run last export again",
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
      name: "Open last exported file",
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
      name: "Reveal last exported file",
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
      name: "Copy last exported path",
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
      name: "Show export history",
      callback: () => this.openExportHistory(),
    });

    this.addCommand({
      id: "quick-switch-html-profile",
      name: "Quick switch HTML export profile",
      callback: () => this.openHtmlProfileSwitcher(),
    });

    this.addCommand({
      id: "export-settings-json",
      name: "Export settings JSON",
      callback: () => void this.exportSettingsJson(),
    });

    this.addCommand({
      id: "import-settings-json-from-clipboard",
      name: "Import settings JSON from clipboard",
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
            .setTitle("Copy selection as HTML")
            .setIcon("copy")
            .onClick(() => void this.copySelectionAsHtml(editor, view));
        });
        this.addHtmlCopyAsMenuItems(menu, async () => this.renderMarkdownToHtml(editor.getSelection(), view.file?.path ?? ""), view.file?.path ?? null, "selection");
        menu.addItem((item) => {
          item
            .setTitle("Preview selection as HTML")
            .setIcon("eye")
            .onClick(() => void this.previewSelectionAsHtml(editor, view));
        });
        menu.addItem((item) => {
          item
            .setTitle("Compare HTML styles")
            .setIcon("columns-3")
            .onClick(() => void this.compareMarkdownHtmlStyles(editor.getSelection(), view.file?.path ?? "", "Selection style comparison"));
        });
        menu.addItem((item) => {
          item
            .setTitle("Save selection as HTML file")
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
          .setTitle(`Download SVG as ${this.settings.imageFormat.toUpperCase()}`)
          .setIcon("image-down")
          .onClick(() => void this.exportSvgTarget(svgTarget, this.settings.imageFormat));
      });
      menu.addItem((item) => {
        const alternateFormat = this.settings.imageFormat === "png" ? "jpeg" : "png";
        item
          .setTitle(`Download SVG as ${alternateFormat.toUpperCase()}`)
          .setIcon("image")
          .onClick(() => void this.exportSvgTarget(svgTarget, alternateFormat));
      });
      menu.addItem((item) => {
        item
          .setTitle("Preview SVG export")
          .setIcon("eye")
          .onClick(() => void this.previewSvgTarget(svgTarget));
      });
      menu.addItem((item) => {
        item
          .setTitle("Diagnose SVG export")
          .setIcon("search-check")
          .onClick(() => void this.diagnoseSvgTarget(svgTarget));
      });
      menu.showAtMouseEvent(event);
    }, { capture: true });
  }

  async loadSettings() {
    const loadedSettings = await this.loadData() as Partial<OwenExporterSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loadedSettings ?? {}) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
      new Notice("No previous export to run");
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
      new Notice(`Failed to run last export: ${error instanceof Error ? error.message : String(error)}`);
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
      new Notice("Unable to reveal this exported file");
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
    new Notice("Copied last exported path");
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
        .setTitle("Copy selection as HTML")
        .setIcon("copy")
        .onClick(() => void this.copyHtmlExport(html, this.getActiveSourcePath(), "selection"));
    });
    menu.addItem((item) => {
      item
        .setTitle("Copy selection as plain text")
        .setIcon("text")
        .onClick(() => void this.copyHtmlWithTemporaryOptions(html, this.getActiveSourcePath(), "selection", { htmlClipboardMode: "text" }));
    });
    menu.addItem((item) => {
      item
        .setTitle("Preview selection as HTML")
        .setIcon("eye")
        .onClick(() => this.openHtmlPreview("Selection HTML preview", html, this.getActiveSourcePath(), "selection"));
    });
    menu.addItem((item) => {
      item
        .setTitle("Save selection as HTML file")
        .setIcon("file-down")
        .onClick(() => void this.saveHtmlToFile(html, this.getActiveSourcePath(), "selection"));
    });
    menu.showAtMouseEvent(event);
  }

  private addHtmlCopyAsMenuItems(menu: Menu, renderHtml: () => Promise<string>, sourcePath: string | null, fallbackName: string) {
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("Copy as Obsidian-like HTML")
        .setIcon("copy")
        .onClick(() => void this.copyRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlStyleMode: "obsidian", htmlClipboardMode: "html-and-text" }));
    });
    menu.addItem((item) => {
      item
        .setTitle("Copy as Portable HTML")
        .setIcon("copy")
        .onClick(() => void this.copyRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlStyleMode: "portable", htmlClipboardMode: "html-and-text" }));
    });
    menu.addItem((item) => {
      item
        .setTitle("Copy as Clean HTML")
        .setIcon("copy")
        .onClick(() => void this.copyRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlStyleMode: "clean", htmlClipboardMode: "html" }));
    });
    menu.addItem((item) => {
      item
        .setTitle("Copy as plain text")
        .setIcon("text")
        .onClick(() => void this.copyRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlClipboardMode: "text" }));
    });
    menu.addItem((item) => {
      item
        .setTitle("Save as full HTML document")
        .setIcon("file-down")
        .onClick(() => void this.saveRenderedHtmlWithTemporaryOptions(renderHtml, sourcePath, fallbackName, { htmlSaveMode: "document" }));
    });
    menu.addItem((item) => {
      item
        .setTitle("Save as HTML fragment")
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
      new Notice(`Failed to preview SVG: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private openSvgPreview(svgText: string, baseName: string, sourcePath: string | null, format: ExportImageFormat) {
    const dimensions = getSvgDimensionsFromText(svgText);
    const scale = this.getImageScale();
    const outputWidth = Math.max(1, Math.round(dimensions.width * scale));
    const outputHeight = Math.max(1, Math.round(dimensions.height * scale));
    const extension = format === "jpeg" ? "jpg" : "png";
    const filename = this.buildImageFilename(baseName, format, extension, { sourcePath, heading: baseName });
    new SvgPreviewModal(this.app, {
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
      new Notice(`Failed to export SVG: ${error instanceof Error ? error.message : String(error)}`);
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
      label: `Export ${baseName} as ${format.toUpperCase()}`,
    });
    await this.recordSavedFile(saved, "image-save", `Export ${baseName} as ${format.toUpperCase()}`);
    if (this.settings.afterImageExportInsertMarkdownLink && saved.vaultPath) {
      this.insertMarkdownLinkForExport(saved.vaultPath);
    }
    new Notice(`Saved ${format.toUpperCase()} export: ${saved.vaultPath ?? saved.systemPath ?? saved.filename}`);
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
            description: `${extension.toUpperCase()} image`,
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
      title: "Save SVG export",
      defaultPath: filename,
      filters: [{ name: `${extension.toUpperCase()} image`, extensions: [extension] }],
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
      warnings.push("External image, font, or stylesheet references may block canvas export.");
    }
    if (width * height > MAX_CANVAS_PIXELS) {
      warnings.push(`Estimated output is too large (${width}x${height}). Lower the image scale.`);
    }
    if ((format === "jpeg" || this.settings.imageBackground.trim().toLowerCase() !== "transparent") && !this.isValidCssColor(this.settings.imageBackground)) {
      warnings.push(`Invalid image background color: ${this.settings.imageBackground}`);
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
        new Notice(`SVG export warning: ${warnings[0]}`);
        return;
      }
      new Notice(`SVG export looks ready (${Math.round(dimensions.width)}x${Math.round(dimensions.height)} @ ${this.getImageScale()}x)`);
    } catch (error) {
      console.error(error);
      new Notice(`SVG export diagnostic failed: ${error instanceof Error ? error.message : String(error)}`);
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
    this.openHtmlPreview("Selection HTML preview", html, view.file?.path ?? null, "selection");
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
    this.openHtmlPreview("Current note HTML preview", html, view.file.path, "note");
  }

  private async compareCurrentNoteHtmlStyles(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    await this.compareMarkdownHtmlStyles(markdown, view.file.path, `${view.file.basename} style comparison`);
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
    new HtmlPreviewModal(this.app, {
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
      label: `Copy ${fallbackName} as HTML`,
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
    new Notice("Copied selection as HTML");
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
    await this.recordSavedFile({ filename, vaultPath: outputPath }, "html-save", `Save ${fallbackName} as HTML`);
    this.recordLastExport({
      type: "html-save",
      html,
      sourcePath,
      fallbackName,
      label: `Save ${fallbackName} as HTML`,
    });
    new Notice(`Saved HTML export: ${outputPath}`);
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
    await this.exportMarkdownFilesAsHtml(files, folder || "vault root");
  }

  private async exportChangedCurrentFolderNotesAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const folder = this.getFolderPath(view.file.path);
    const files = await this.filterChangedMarkdownFiles(this.app.vault.getMarkdownFiles().filter((file) => this.getFolderPath(file.path) === folder));
    await this.exportMarkdownFilesAsHtml(files, `changed notes in ${folder || "vault root"}`);
  }

  private async exportLinkedNotesAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    const files = this.getLinkedMarkdownFiles(markdown, view.file.path);
    await this.exportMarkdownFilesAsHtml(files, `links from ${view.file.basename}`);
  }

  private async exportChangedLinkedNotesAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    const files = await this.filterChangedMarkdownFiles(this.getLinkedMarkdownFiles(markdown, view.file.path));
    await this.exportMarkdownFilesAsHtml(files, `changed links from ${view.file.basename}`);
  }

  private async exportMarkdownFilesAsHtml(files: TFile[], label: string) {
    if (!files.length) {
      new Notice("No Markdown notes found to export");
      return;
    }
    let savedCount = 0;
    const failures: string[] = [];
    const manifestEntries: ExportManifestEntry[] = [];
    const job = this.createExportJob(`Export ${label}`, files.map((file) => file.path));
    for (const [index, file] of files.entries()) {
      if (job.cancelled) {
        job.modal.updateEntry(index, "skipped", "Cancelled");
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
      new Notice(`Exported ${savedCount}/${files.length} notes from ${label}. Check the console for failed files.`);
      return;
    }
    new Notice(`Exported ${savedCount} notes from ${label}`);
  }

  private createExportJob(title: string, labels: string[]): ExportJobController {
    const modal = new ExportJobModal(this.app, title, labels);
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
    await this.recordSavedFile({ filename: "export-manifest.json", vaultPath: outputPath }, "report", "Export manifest");
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
    new ExportHistoryModal(this.app, this.recentExports, {
      open: (entry) => this.openExportedResult(entry),
      reveal: (entry) => this.revealExportedResult(entry),
      copyPath: async (entry) => {
        await navigator.clipboard.writeText(entry.systemPath ?? entry.vaultPath ?? entry.filename);
        new Notice("Copied export path");
      },
      clear: () => {
        this.recentExports = [];
        new Notice("Export history cleared");
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
      { label: "Obsidian-like", html: obsidianHtml },
      { label: "Portable", html: portableHtml },
      { label: "Clean", html: cleanHtml },
    ]).open();
  }

  openHtmlProfileSwitcher() {
    const profiles = [
      { name: "obsidian-document", label: "Obsidian-like document" },
      { name: "portable-document", label: "Portable document" },
      { name: "clean-fragment", label: "Clean fragment" },
      ...this.settings.htmlCustomProfiles.map((profile) => ({ name: profile.name, label: profile.name })),
    ];
    new ProfileSwitcherModal(this.app, profiles, async (name) => {
      Object.assign(this.settings, name in HTML_EXPORT_PROFILES ? HTML_EXPORT_PROFILES[name as Exclude<HtmlExportProfile, "custom">] : this.getHtmlProfileSettings(name));
      this.settings.htmlExportProfile = name in HTML_EXPORT_PROFILES ? name as HtmlExportProfile : "custom";
      await this.saveSettings();
      new Notice(`Using HTML profile: ${name}`);
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
      new Notice(`Found ${issues.length} export issues. Report: ${outputPath}`);
      return;
    }
    new Notice(`No export issues found. Report: ${outputPath}`);
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
    await this.recordSavedFile({ filename, vaultPath: outputPath }, "report", "Export validation report");
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
    await this.recordSavedFile({ filename, vaultPath: outputPath }, "report", "Owen Exporter settings backup");
    new Notice(`Exported settings: ${outputPath}`);
  }

  async importSettingsJsonFromClipboard() {
    const text = await navigator.clipboard.readText();
    let payload: ExporterSettingsFile;
    try {
      payload = JSON.parse(text) as ExporterSettingsFile;
    } catch {
      new Notice("Clipboard does not contain valid JSON");
      return;
    }
    if (!payload || typeof payload !== "object" || !payload.settings || typeof payload.settings !== "object") {
      new Notice("Clipboard JSON is not an Owen Exporter settings backup");
      return;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, payload.settings);
    await this.saveSettings();
    new Notice("Imported Owen Exporter settings");
  }

  private async exportCurrentNoteSvgs(view: MarkdownView) {
    if (!view.file) {
      return;
    }

    const markdown = await this.app.vault.read(view.file);
    const files = this.getSvgFilesFromMarkdown(markdown, view.file.path);
    if (!files.length) {
      new Notice("No SVG embeds found in the current note");
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
        await this.recordSavedFile({ filename, vaultPath: outputPath }, "image-save", `Batch SVG export ${index + 1}`);
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
      new Notice(`Exported ${savedCount}/${files.length} SVGs.${reportPath ? ` Report: ${reportPath}` : " Check the console for failed files."}`);
      return;
    }

    new Notice(`Exported ${savedCount} SVGs to ${normalizeVaultFolder(this.settings.imageOutputFolder) || "the vault root"}${reportPath ? `. Report: ${reportPath}` : ""}`);
  }

  private async diagnoseCurrentNoteSvgs(view: MarkdownView) {
    if (!view.file) {
      return;
    }

    const markdown = await this.app.vault.read(view.file);
    const files = this.getSvgFilesFromMarkdown(markdown, view.file.path);
    if (!files.length) {
      new Notice("No SVG embeds found in the current note");
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
      new Notice(`${warnings.length}/${results.length} SVGs may need attention. Check the console for details.`);
      return;
    }
    new Notice(`All ${results.length} SVG embeds look ready for export`);
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
    await this.recordSavedFile({ filename, vaultPath: outputPath }, "report", "SVG batch export report");
    return outputPath;
  }

  private escapeMarkdownTableCell(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ");
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

  constructor(app: App, options: HtmlPreviewOptions) {
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
          .setButtonText("Copy HTML")
          .setIcon("copy")
          .onClick(async () => {
            await this.runAction(this.options.onCopy);
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Save HTML")
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

  constructor(app: App, options: SvgPreviewOptions) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-svg-preview-modal");
    contentEl.createEl("h2", { text: "SVG export preview" });

    const meta = contentEl.createDiv({ cls: "owen-exporter-preview-meta" });
    this.addMeta(meta, "Filename", this.options.filename);
    this.addMeta(meta, "Source size", `${Math.round(this.options.dimensions.width)} x ${Math.round(this.options.dimensions.height)}`);
    this.addMeta(meta, "Output size", `${this.options.outputWidth} x ${this.options.outputHeight}`);
    this.addMeta(meta, "Format", this.options.format.toUpperCase());
    this.addMeta(meta, "Background", this.options.background || "transparent");

    if (this.options.warnings.length) {
      const warningList = contentEl.createDiv({ cls: "owen-exporter-preview-warnings" });
      for (const warning of this.options.warnings) {
        warningList.createDiv({ text: warning });
      }
    }

    new Setting(contentEl)
      .addButton((button) => {
        button
          .setButtonText("Export PNG")
          .setIcon("image-down")
          .onClick(async () => this.runExport("png"));
      })
      .addButton((button) => {
        button
          .setButtonText("Export JPEG")
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

  constructor(app: App, entries: RecentExportEntry[], actions: ExportHistoryActions) {
    super(app);
    this.entries = entries;
    this.actions = actions;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-history-modal");
    contentEl.createEl("h2", { text: "Export history" });

    if (!this.entries.length) {
      contentEl.createDiv({ cls: "owen-exporter-empty-state", text: "No exports recorded in this session." });
      return;
    }

    new Setting(contentEl).addButton((button) => {
      button
        .setButtonText("Clear history")
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
      text.createDiv({ cls: "owen-exporter-history-date", text: new Date(entry.createdAt).toLocaleString() });

      const actions = row.createDiv({ cls: "owen-exporter-history-actions" });
      this.addActionButton(actions, "Open", "external-link", () => this.actions.open(entry));
      this.addActionButton(actions, "Reveal", "folder-open", () => this.actions.reveal(entry));
      this.addActionButton(actions, "Copy path", "copy", () => this.actions.copyPath(entry));
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

  constructor(app: App, private title: string, labels: string[]) {
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
        .setButtonText("Cancel")
        .setIcon("x")
        .onClick(() => {
          this.onCancel?.();
          new Notice("Export job will stop after the current file");
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
      row.createSpan({ text: entry.detail ?? entry.status });
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
  constructor(app: App, private profiles: Array<{ name: string; label: string }>, private onApply: (name: string) => Promise<void>) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("owen-exporter-profile-switcher-modal");
    contentEl.createEl("h2", { text: "HTML export profiles" });
    const list = contentEl.createDiv({ cls: "owen-exporter-profile-list" });
    for (const profile of this.profiles) {
      const row = list.createDiv({ cls: "owen-exporter-profile-row" });
      row.createEl("strong", { text: profile.label });
      const button = row.createEl("button", { text: "Use profile" });
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
    const imageGroup = this.createSettingsGroup(
      settingsRoot,
      "SVG image export",
      "Configure rasterized SVG downloads, vault saves, filenames, and batch reports.",
      "image-down",
    );
    const htmlGroup = this.createSettingsGroup(
      settingsRoot,
      "Markdown to HTML",
      "Configure HTML preview, document output, clipboard formats, and filename templates.",
      "file-code",
    );
    const workflowGroup = this.createSettingsGroup(
      settingsRoot,
      "Workflow automation",
      "Choose what happens after exports and manage reusable HTML profiles.",
      "workflow",
    );
    const backupGroup = this.createSettingsGroup(
      settingsRoot,
      "Backup and restore",
      "Export settings to a vault JSON file or import settings from clipboard JSON.",
      "archive-restore",
    );

    new Setting(imageGroup)
      .setName("Default image format")
      .setDesc("Format used by the primary SVG download menu item.")
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
      .setName("Image save location")
      .setDesc("Ask for a save location or save directly into a vault folder.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("dialog", "Ask every time")
          .addOption("vault", "Save to vault folder")
          .setValue(this.plugin.settings.imageSaveMode)
          .onChange(async (value: ImageSaveMode) => {
            this.plugin.settings.imageSaveMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName("Image output folder")
      .setDesc("Vault-relative folder for direct SVG image exports and batch exports.")
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
      .setName("SVG batch report")
      .setDesc("Write a Markdown report for batch SVG exports.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("on-failure", "Only when something fails")
          .addOption("always", "Always")
          .addOption("never", "Never")
          .setValue(this.plugin.settings.svgBatchReportMode)
          .onChange(async (value: SvgBatchReportMode) => {
            this.plugin.settings.svgBatchReportMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(imageGroup)
      .setName("Image filename template")
      .setDesc("Supports {{name}}, {{rawName}}, {{note}}, {{folder}}, {{heading}}, {{index}}, {{format}}, {{scale}}, {{date}}, and {{time}}.")
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
      .setName("Image quality")
      .setDesc("JPEG quality from 0.1 to 1.0. PNG ignores this setting.")
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
      .setName("Image scale")
      .setDesc("Rasterization multiplier. Use 2 or 3 for high-resolution exports.")
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
      .setName("Image background")
      .setDesc("Canvas background used for JPEG and transparent SVGs. Use a CSS color such as #FFFFFF.")
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
      .setName("HTML export profile")
      .setDesc("Apply a preset for common HTML export destinations.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("custom", "Custom")
          .addOption("obsidian-document", "Obsidian-like document")
          .addOption("portable-document", "Portable document")
          .addOption("clean-fragment", "Clean fragment")
          .setValue(this.plugin.settings.htmlExportProfile)
          .onChange(async (value: HtmlExportProfile) => {
            await this.applyHtmlProfile(value);
          });
      });

    new Setting(htmlGroup)
      .setName("HTML output folder")
      .setDesc("Vault-relative folder for saved HTML selections.")
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
      .setName("HTML filename template")
      .setDesc("Supports {{name}}, {{rawName}}, {{note}}, {{folder}}, {{heading}}, {{index}}, {{format}}, {{date}}, and {{time}}.")
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
      .setName("HTML save mode")
      .setDesc("Save a full HTML document or only the rendered selection fragment.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("document", "Full HTML document")
          .addOption("fragment", "HTML fragment only")
          .setValue(this.plugin.settings.htmlSaveMode)
          .onChange(async (value: HtmlSaveMode) => {
            this.markCustomHtmlProfile();
            this.plugin.settings.htmlSaveMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName("HTML style mode")
      .setDesc("Choose how much of the active Obsidian preview styling is inlined.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("obsidian", "Obsidian-like")
          .addOption("portable", "Portable")
          .addOption("clean", "Clean HTML")
          .setValue(this.plugin.settings.htmlStyleMode)
          .onChange(async (value: HtmlStyleMode) => {
            this.markCustomHtmlProfile();
            this.plugin.settings.htmlStyleMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName("Clipboard format")
      .setDesc("Choose which clipboard formats are written by HTML copy actions.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("html-and-text", "HTML and plain text")
          .addOption("html", "HTML only")
          .addOption("text", "Plain text only")
          .setValue(this.plugin.settings.htmlClipboardMode)
          .onChange(async (value: HtmlClipboardMode) => {
            this.plugin.settings.htmlClipboardMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName("HTML document title")
      .setDesc("Title used for full HTML documents. Supports the same filename tokens.")
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
      .setName("Exclude frontmatter")
      .setDesc("Remove YAML frontmatter before rendering Markdown to HTML.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.htmlExcludeFrontmatter)
          .onChange(async (value) => {
            this.plugin.settings.htmlExcludeFrontmatter = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName("Preserve heading IDs")
      .setDesc("Keep heading id attributes in exported HTML.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.htmlPreserveHeadingIds)
          .onChange(async (value) => {
            this.plugin.settings.htmlPreserveHeadingIds = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName("Preserve callout classes")
      .setDesc("Keep Obsidian callout classes and data attributes after styles are inlined.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.htmlPreserveCalloutClasses)
          .onChange(async (value) => {
            this.plugin.settings.htmlPreserveCalloutClasses = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName("Convert internal links")
      .setDesc("Convert internal note links to obsidian://open URIs in exported HTML.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.htmlConvertInternalLinksToObsidianUris)
          .onChange(async (value) => {
            this.plugin.settings.htmlConvertInternalLinksToObsidianUris = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName("HTML asset handling")
      .setDesc("Keep, relativize, copy, or inline local images referenced by exported HTML.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("keep", "Keep current paths")
          .addOption("relative", "Use relative vault paths")
          .addOption("copy", "Copy assets to folder")
          .addOption("base64", "Inline as base64")
          .setValue(this.plugin.settings.htmlAssetMode)
          .onChange(async (value: HtmlAssetMode) => {
            this.plugin.settings.htmlAssetMode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(htmlGroup)
      .setName("HTML asset output folder")
      .setDesc("Vault-relative folder used when HTML asset handling copies local files.")
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
      .setName("HTML document template")
      .setDesc("Optional full-document template. Supports {{title}}, {{content}}, {{sourcePath}}, {{style}}, and filename tokens.")
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
      .setName("Quick switch profile")
      .setDesc("Open a compact profile picker without leaving this settings tab.")
      .addButton((button) => {
        button
          .setButtonText("Open switcher")
          .setIcon("list-filter")
          .onClick(() => this.plugin.openHtmlProfileSwitcher());
      });

    new Setting(workflowGroup)
      .setName("Write export manifest")
      .setDesc("Write export-manifest.json after batch HTML exports so changed-only exports can skip unchanged notes.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.writeExportManifest)
          .onChange(async (value) => {
            this.plugin.settings.writeExportManifest = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(workflowGroup)
      .setName("Save current HTML profile")
      .setDesc("Save the current HTML output, style, clipboard, filename, and title settings as a reusable profile.")
      .addText((text) => {
        text
          .setPlaceholder("Blog clean HTML")
          .onChange((value) => {
            profileName = value.trim();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Save profile")
          .setIcon("save")
          .onClick(async () => {
            await this.saveCurrentHtmlProfile(profileName);
          });
      });

    if (this.plugin.settings.htmlCustomProfiles.length) {
      new Setting(workflowGroup)
        .setName("Apply custom HTML profile")
        .setDesc("Apply one of your saved HTML export profiles.")
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
            .setButtonText("Delete")
            .setIcon("trash")
            .onClick(async () => {
              const name = activeWindow.prompt("Custom profile name to delete");
              if (name) {
                await this.deleteCustomHtmlProfile(name.trim());
              }
            });
        });
    }

    new Setting(workflowGroup)
      .setName("Open file after export")
      .setDesc("Open the exported vault or system file after it is saved.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.afterExportOpenFile)
          .onChange(async (value) => {
            this.plugin.settings.afterExportOpenFile = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(workflowGroup)
      .setName("Reveal file after export")
      .setDesc("Show the exported file in the system file manager after it is saved.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.afterExportRevealFile)
          .onChange(async (value) => {
            this.plugin.settings.afterExportRevealFile = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(workflowGroup)
      .setName("Copy path after export")
      .setDesc("Copy the exported file path after it is saved.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.afterExportCopyPath)
          .onChange(async (value) => {
            this.plugin.settings.afterExportCopyPath = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(workflowGroup)
      .setName("Insert image link after SVG export")
      .setDesc("When a SVG export is saved to the vault, insert a Markdown image link at the active cursor.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.afterImageExportInsertMarkdownLink)
          .onChange(async (value) => {
            this.plugin.settings.afterImageExportInsertMarkdownLink = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(backupGroup)
      .setName("Settings JSON")
      .setDesc("Export settings to the HTML output folder or import settings JSON from the clipboard.")
      .addButton((button) => {
        button
          .setButtonText("Export")
          .setIcon("download")
          .onClick(() => void this.plugin.exportSettingsJson());
      })
      .addButton((button) => {
        button
          .setButtonText("Import from clipboard")
          .setIcon("clipboard")
          .onClick(() => void this.plugin.importSettingsJsonFromClipboard());
      });
  }

  private createSettingsGroup(parent: HTMLElement, title: string, description: string, _icon: string): HTMLElement {
    const group = parent.createDiv({ cls: "owen-exporter-settings-group" });
    const header = group.createDiv({ cls: "owen-exporter-settings-group-header" });
    new Setting(header)
      .setName(title)
      .setDesc(description)
      .setHeading();

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
      new Notice("Enter a profile name first");
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
    new Notice(`Saved HTML profile: ${name}`);
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
    new Notice(`Applied HTML profile: ${name}`);
    this.renderSettings();
  }

  private async deleteCustomHtmlProfile(name: string) {
    const before = this.plugin.settings.htmlCustomProfiles.length;
    this.plugin.settings.htmlCustomProfiles = this.plugin.settings.htmlCustomProfiles.filter((profile) => profile.name !== name);
    if (this.plugin.settings.htmlCustomProfiles.length === before) {
      new Notice(`No custom profile named ${name}`);
      return;
    }
    await this.plugin.saveSettings();
    new Notice(`Deleted HTML profile: ${name}`);
    this.renderSettings();
  }

  private markCustomHtmlProfile() {
    this.plugin.settings.htmlExportProfile = "custom";
  }
}
