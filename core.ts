export interface SvgDimensions {
  width: number;
  height: number;
}

export type FileExists = (path: string) => boolean | Promise<boolean>;
export type FilenameTokens = Record<string, string | number | null | undefined>;

export const DEFAULT_SVG_DIMENSIONS: SvgDimensions = { width: 1000, height: 1000 };

export function slugifyExportName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "export";
}

export function normalizeVaultFolder(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "").replace(/\\+/g, "/");
}

export function renderFilenameTemplate(template: string, tokens: FilenameTokens, fallbackName: string): string {
  const source = template.trim() || "{{name}}";
  const rendered = source.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, key: string) => {
    const value = tokens[key];
    return value === null || value === undefined ? "" : String(value);
  });
  return slugifyExportName(rendered || fallbackName);
}

export async function nextAvailableVaultPath(folder: string, filename: string, exists: FileExists): Promise<string> {
  const normalizedFolder = normalizeVaultFolder(folder);
  const dotIndex = filename.lastIndexOf(".");
  const name = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
  const extension = dotIndex >= 0 ? filename.slice(dotIndex) : "";
  let candidate = normalizedFolder ? `${normalizedFolder}/${filename}` : filename;
  let counter = 2;
  while (await exists(candidate)) {
    candidate = normalizedFolder ? `${normalizedFolder}/${name}-${counter}${extension}` : `${name}-${counter}${extension}`;
    counter += 1;
  }
  return candidate;
}

export function parseSvgLength(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function getSvgDimensionsFromText(svgText: string): SvgDimensions {
  const svgMatch = svgText.match(/<svg\b[^>]*>/i);
  if (!svgMatch) {
    return DEFAULT_SVG_DIMENSIONS;
  }

  const svgOpenTag = svgMatch[0];
  const width = parseSvgLength(getAttributeValue(svgOpenTag, "width"));
  const height = parseSvgLength(getAttributeValue(svgOpenTag, "height"));
  if (width && height) {
    return { width, height };
  }

  const viewBox = getAttributeValue(svgOpenTag, "viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3]) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }

  return DEFAULT_SVG_DIMENSIONS;
}

function getAttributeValue(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return tag.match(pattern)?.[2] ?? null;
}
