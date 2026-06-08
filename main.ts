import { remote } from "electron";
import { writeFile } from "fs/promises";
import {
    App,
    Component,
    Editor,
    FileSystemAdapter,
    MarkdownRenderer,
    MarkdownView,
    Menu,
    Notice,
    Platform,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    normalizePath,
    requestUrl,
} from "obsidian";

type ExportImageFormat = "png" | "jpeg";
type HtmlSaveMode = "fragment" | "document";

interface OwenExporterSettings {
  imageFormat: ExportImageFormat;
  imageQuality: number;
  imageScale: number;
  imageBackground: string;
  imageOutputFolder: string;
  htmlOutputFolder: string;
  htmlSaveMode: HtmlSaveMode;
}

interface SvgTarget {
  element: SVGSVGElement | HTMLImageElement;
  sourcePath: string | null;
  suggestedName: string;
}

interface MarkdownSourceInfo {
  file?: TFile | null;
}

interface SvgDimensions {
  width: number;
  height: number;
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
  imageQuality: 0.92,
  imageScale: 2,
  imageBackground: "#FFFFFF",
  imageOutputFolder: "exports/images",
  htmlOutputFolder: "exports/html",
  htmlSaveMode: "document",
};

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
      menu.showAtMouseEvent(event);
    }, { capture: true });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
        .onClick(() => void this.copyHtmlToClipboard(html));
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
      const raster = await this.rasterizeSvg(svgText, format);
      const extension = format === "jpeg" ? "jpg" : "png";
      const baseName = this.slugify(target.suggestedName.replace(/\.svg$/i, ""));
      const filename = `${baseName}.${extension}`;
      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
      const blob = new Blob([raster], { type: mimeType });

      await this.saveBlobWithPicker(blob, filename, mimeType, extension);
      new Notice(`Saved ${format.toUpperCase()} export: ${filename}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      console.error(error);
      new Notice(`Failed to export SVG: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async saveBlobWithPicker(blob: Blob, filename: string, mimeType: string, extension: string) {
    if (Platform.isDesktopApp && await this.saveBlobWithElectronDialog(blob, filename, extension)) {
      return;
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
      return;
    }

    this.downloadBlobWithAnchor(blob, filename);
  }

  private async saveBlobWithElectronDialog(blob: Blob, filename: string, extension: string): Promise<boolean> {
    const dialog = remote?.dialog;
    if (!dialog) {
      return false;
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
    return true;
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
    const dimensions = this.getSvgDimensions(svgText);
    const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);

    try {
      await new Promise<HTMLImageElement>((resolve, reject) => {
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Browser could not rasterize this SVG"));
        image.src = objectUrl;
      });

      const width = Math.max(1, Math.round(dimensions.width * this.settings.imageScale));
      const height = Math.max(1, Math.round(dimensions.height * this.settings.imageScale));
      const canvas = activeDocument.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas rendering is unavailable");
      }

      if (format === "jpeg" || this.settings.imageBackground.trim().toLowerCase() !== "transparent") {
        context.fillStyle = this.settings.imageBackground || "#FFFFFF";
        context.fillRect(0, 0, width, height);
      }

      context.drawImage(image, 0, 0, width, height);
      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
      const outputBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("Canvas export failed"))),
          mimeType,
          this.settings.imageQuality,
        );
      });
      return outputBlob.arrayBuffer();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  private ensureSvgNamespace(svgText: string): string {
    if (/xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(svgText)) {
      return svgText;
    }
    return svgText.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  private getSvgDimensions(svgText: string): SvgDimensions {
    const parsedDocument = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = parsedDocument.querySelector("svg");
    const width = this.parseSvgLength(svg?.getAttribute("width"));
    const height = this.parseSvgLength(svg?.getAttribute("height"));
    if (width && height) {
      return { width, height };
    }

    const viewBox = svg?.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
    if (viewBox?.length === 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3]) && viewBox[2] > 0 && viewBox[3] > 0) {
      return { width: viewBox[2], height: viewBox[3] };
    }

    return { width: 1000, height: 1000 };
  }

  private parseSvgLength(value: string | null | undefined): number | null {
    if (!value) {
      return null;
    }
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  private async copySelectionAsHtml(editor: Editor, view: MarkdownSourceInfo) {
    const html = await this.renderMarkdownToHtml(editor.getSelection(), view.file?.path ?? "");
    await this.copyHtmlToClipboard(html);
  }

  private async saveSelectionAsHtml(editor: Editor, view: MarkdownSourceInfo) {
    const html = await this.renderMarkdownToHtml(editor.getSelection(), view.file?.path ?? "");
    await this.saveHtmlToFile(html, view.file?.path ?? null, "selection");
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

  private wrapHtmlDocument(fragment: string): string {
    return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Obsidian selection export</title>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
  }

  private async copyHtmlToClipboard(html: string) {
    if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([html], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(html);
    }
    new Notice("Copied selection as HTML");
  }

  private async saveHtmlToFile(html: string, sourcePath: string | null, fallbackName: string) {
    await this.ensureFolder(this.settings.htmlOutputFolder);
    const baseName = sourcePath ? this.basename(sourcePath) : fallbackName;
    const outputPath = await this.nextAvailablePath(this.settings.htmlOutputFolder, `${this.slugify(baseName)}.html`);
    const content = this.settings.htmlSaveMode === "document" ? this.wrapHtmlDocument(html) : html;
    await this.app.vault.adapter.write(outputPath, content);
    new Notice(`Saved HTML export: ${outputPath}`);
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
    this.inlineElementStyle(container);
    const elements = Array.from(container.querySelectorAll<HTMLElement>(HTML_STYLE_SELECTOR));
    for (const element of elements) {
      this.inlineElementStyle(element);
    }
  }

  private inlineElementStyle(element: HTMLElement) {
    const computed = activeWindow.getComputedStyle(element);
    const styles: Record<string, string> = {};
    for (const property of HTML_STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) {
        styles[property] = value;
      }
    }
    for (const variable of HTML_STYLE_VARIABLES) {
      const value = computed.getPropertyValue(variable);
      if (value) {
        styles[variable] = value;
      }
    }
    this.normalizePortableHtmlStyles(element, styles);
    element.setCssProps(styles);
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

  private getActiveSourcePath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path ?? null;
  }

  private basename(path: string): string {
    return path.split("/").pop()?.replace(/\.[^.]+$/, "") || "export";
  }

  private slugify(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9가-힣._-]+/gi, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "export";
  }

  private async ensureFolder(folder: string) {
    const normalized = normalizePath(folder.trim().replace(/^\/+|\/+$/g, ""));
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
    const normalizedFolder = normalizePath(folder.trim().replace(/^\/+|\/+$/g, ""));
    const dotIndex = filename.lastIndexOf(".");
    const name = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
    const extension = dotIndex >= 0 ? filename.slice(dotIndex) : "";
    let candidate = normalizePath(normalizedFolder ? `${normalizedFolder}/${filename}` : filename);
    let counter = 2;
    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = normalizePath(normalizedFolder ? `${normalizedFolder}/${name}-${counter}${extension}` : `${name}-${counter}${extension}`);
      counter += 1;
    }
    return candidate;
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

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName("HTML save mode")
      .setDesc("Save a full HTML document or only the rendered selection fragment.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("document", "Full HTML document")
          .addOption("fragment", "HTML fragment only")
          .setValue(this.plugin.settings.htmlSaveMode)
          .onChange(async (value: HtmlSaveMode) => {
            this.plugin.settings.htmlSaveMode = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
