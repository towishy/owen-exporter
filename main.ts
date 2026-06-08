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
    setIcon,
} from "obsidian";
import {
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

interface SvgBatchResult {
  index: number;
  sourcePath: string;
  outputPath?: string;
  error?: string;
}

interface HtmlPreviewOptions {
  title: string;
  html: string;
  onCopy: () => Promise<void>;
  onSave: () => Promise<void>;
}

interface SvgTarget {
  element: SVGSVGElement | HTMLImageElement;
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
};

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
        menu.addItem((item) => {
          item
            .setTitle("Preview selection as HTML")
            .setIcon("eye")
            .onClick(() => void this.previewSelectionAsHtml(editor, view));
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
          .setTitle("Diagnose SVG export")
          .setIcon("search-check")
          .onClick(() => void this.diagnoseSvgTarget(svgTarget));
      });
      menu.showAtMouseEvent(event);
    }, { capture: true });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private recordLastExport(action: LastExportAction) {
    this.lastExportAction = action;
  }

  private recordSavedFile(result: SavedFileResult) {
    this.lastExportResult = {
      filename: result.filename,
      vaultPath: result.vaultPath,
      systemPath: result.systemPath,
    };
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

  private async revealLastExportedFile() {
    const result = this.lastExportResult;
    if (!result) {
      return;
    }

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

  private findSvgTarget(event: MouseEvent): SvgTarget | null {
    for (const element of this.getContextPathElements(event)) {
      if (!this.isInsideMarkdownContent(element)) {
        continue;
      }

      const inlineSvg = this.findClosestOrChildSvg(element);
      if (inlineSvg) {
        return {
          element: inlineSvg,
          sourcePath: this.getActiveSourcePath(),
          suggestedName: inlineSvg.getAttribute("aria-label") ?? inlineSvg.id ?? "inline-svg",
        };
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

  private findClosestOrChildSvg(element: Element): SVGSVGElement | null {
    const closest = element.closest("svg");
    if (this.isSvgElement(closest)) {
      return closest;
    }
    if (!this.isLikelyImageEmbed(element)) {
      return null;
    }
    return element.querySelector("svg");
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
    return value instanceof this.getActiveDomWindow().Element;
  }

  private isHtmlElement(value: unknown): value is HTMLElement {
    return value instanceof this.getActiveDomWindow().HTMLElement;
  }

  private isImageElement(value: Element | null): value is HTMLImageElement {
    if (!value) {
      return false;
    }
    const ownerWindow = this.getOwnerDomWindow(value);
    return value instanceof ownerWindow.HTMLImageElement;
  }

  private isSvgElement(value: Element | null): value is SVGSVGElement {
    if (!value) {
      return false;
    }
    const ownerWindow = this.getOwnerDomWindow(value);
    return value instanceof ownerWindow.SVGSVGElement;
  }

  private getActiveDomWindow(): Window & typeof globalThis {
    return activeWindow as Window & typeof globalThis;
  }

  private getOwnerDomWindow(element: Element): Window & typeof globalThis {
    return (element.ownerDocument.defaultView ?? activeWindow) as Window & typeof globalThis;
  }

  private isSvgImage(image: HTMLImageElement): boolean {
    const source = image.currentSrc || image.src || image.getAttribute("src") || "";
    const alt = image.getAttribute("alt") || "";
    return /\.svg(?:[?#].*)?$/i.test(source) || /\.svg$/i.test(alt) || image.classList.contains("svg");
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
    this.recordSavedFile(saved);
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
    activeWindow.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  private async getSvgText(target: SvgTarget): Promise<string> {
    if (this.isSvgElement(target.element)) {
      return new XMLSerializer().serializeToString(target.element);
    }

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

  private async saveCurrentNoteAsHtml(view: MarkdownView) {
    if (!view.file) {
      return;
    }
    const markdown = await this.app.vault.read(view.file);
    const html = await this.renderMarkdownToHtml(markdown, view.file.path);
    await this.saveHtmlToFile(html, view.file.path, "note");
  }

  private openHtmlPreview(title: string, html: string, sourcePath: string | null, fallbackName: string) {
    new HtmlPreviewModal(this.app, {
      title,
      html,
      onCopy: () => this.copyHtmlExport(html, sourcePath, fallbackName),
      onSave: () => this.saveHtmlToFile(html, sourcePath, fallbackName),
    }).open();
  }

  private async renderMarkdownToHtml(markdown: string, sourcePath: string): Promise<string> {
    const container = this.createHiddenMarkdownRenderHost();
    const renderComponent = new Component();
    activeDocument.body.appendChild(container);
    renderComponent.load();
    try {
      await MarkdownRenderer.render(this.app, markdown, container, sourcePath, renderComponent);
      this.inlinePreviewStyles(container);
      return container.innerHTML.trim();
    } finally {
      renderComponent.unload();
      container.remove();
    }
  }

  private wrapHtmlDocument(fragment: string, title: string): string {
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

  private async saveHtmlToFile(html: string, sourcePath: string | null, fallbackName: string) {
    await this.ensureFolder(this.settings.htmlOutputFolder);
    const baseName = sourcePath ? this.basename(sourcePath) : fallbackName;
    const tokens = this.getFilenameTokens(baseName, "html", { sourcePath, heading: baseName });
    const filename = `${renderFilenameTemplate(this.settings.htmlFilenameTemplate, tokens, baseName)}.html`;
    const outputPath = await this.nextAvailablePath(this.settings.htmlOutputFolder, filename);
    const title = this.renderTextTemplate(this.settings.htmlDocumentTitle, tokens, `${baseName} export`);
    const content = this.settings.htmlSaveMode === "document" ? this.wrapHtmlDocument(html, title) : html;
    await this.app.vault.adapter.write(outputPath, content);
    this.recordSavedFile({ filename, vaultPath: outputPath });
    this.recordLastExport({
      type: "html-save",
      html,
      sourcePath,
      fallbackName,
      label: `Save ${fallbackName} as HTML`,
    });
    new Notice(`Saved HTML export: ${outputPath}`);
  }

  private htmlToPlainText(html: string): string {
    const container = activeDocument.createElement("div");
    container.innerHTML = html;
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
        this.recordSavedFile({ filename, vaultPath: outputPath });
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
    this.recordSavedFile({ filename, vaultPath: outputPath });
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
    preview.innerHTML = this.options.html;
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

class OwenExporterSettingTab extends PluginSettingTab {
  plugin: OwenExporterPlugin;

  constructor(app: App, plugin: OwenExporterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
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
  }

  private createSettingsGroup(parent: HTMLElement, title: string, description: string, icon: string): HTMLElement {
    const group = parent.createDiv({ cls: "owen-exporter-settings-group" });
    const header = group.createDiv({ cls: "owen-exporter-settings-group-header" });
    const iconEl = header.createDiv({ cls: "owen-exporter-settings-group-icon" });
    iconEl.setAttr("aria-hidden", "true");
    setIcon(iconEl, icon);

    const label = header.createDiv({ cls: "owen-exporter-settings-group-label" });
    label.createEl("h3", { text: title });
    label.createEl("p", { text: description });

    return group.createDiv({ cls: "owen-exporter-settings-group-body" });
  }

  private async applyHtmlProfile(profile: HtmlExportProfile) {
    this.plugin.settings.htmlExportProfile = profile;
    if (profile !== "custom") {
      Object.assign(this.plugin.settings, HTML_EXPORT_PROFILES[profile]);
    }
    await this.plugin.saveSettings();
    this.display();
  }

  private markCustomHtmlProfile() {
    this.plugin.settings.htmlExportProfile = "custom";
  }
}
