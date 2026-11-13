import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const MAX_ASSET = 8 * 1024 * 1024;
const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
export class OfficePreviewError extends Error {
  constructor(
    public readonly code:
      | "UNSUPPORTED_HOST"
      | "RENDER_FAILED"
      | "INVALID_OUTPUT"
      | "PREVIEW_TOO_LARGE",
  ) {
    super(code);
    this.name = "OfficePreviewError";
  }
}
export interface OfficeRenderResult {
  content:
    | { kind: "word"; html: string; renderer: "macos-quicklook" }
    | { kind: "workbook"; sheets: { name: string; html: string }[]; renderer: "macos-quicklook" };
  missingResources: boolean;
}

async function localAsset(root: string, name: string): Promise<Buffer> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..")
    throw new OfficePreviewError("INVALID_OUTPUT");
  const file = path.join(root, name);
  const info = await fs.lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_ASSET ||
    (await fs.realpath(file)) !== file
  )
    throw new OfficePreviewError("INVALID_OUTPUT");
  return fs.readFile(file);
}
function decodeLabel(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const known: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity.startsWith("#")) {
      const code =
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return known[entity.toLowerCase()] ?? whole;
  });
}

/** Parse only Quick Look's generated tab envelope; unexpected shapes fail, not flatten to one sheet. */
export function quickLookSheetTabs(html: string): { name: string; file: string }[] {
  const tabs: { name: string; file: string }[] = [];
  const pattern = /<div\s+class="TabHeader">([^<]*)<\/div>\s*<a\s+href="([a-zA-Z0-9_.-]+\.html)"/g;
  for (const match of html.matchAll(pattern))
    tabs.push({ name: decodeLabel(match[1]), file: match[2] });
  if (!tabs.length || tabs.length > 100 || tabs.some((tab) => !tab.name))
    throw new OfficePreviewError("INVALID_OUTPUT");
  return tabs;
}

/** Inline generated local assets only. Neither external links nor document macros are fetched/run. */
export async function bundleQuickLookHtml(
  root: string,
  input: string,
): Promise<{ html: string; missing: boolean }> {
  let missing = false;
  const assets = new Map<string, string>();
  async function asset(name: string): Promise<string> {
    const extension = path.extname(name).toLowerCase();
    const mime = ASSET_TYPES[extension];
    if (!mime) {
      missing = true;
      return "data:,";
    }
    const cached = assets.get(name);
    if (cached) return cached;
    try {
      const data = await localAsset(root, name);
      const uri = `data:${mime};base64,${data.toString("base64")}`;
      assets.set(name, uri);
      return uri;
    } catch (error) {
      if (error instanceof OfficePreviewError) throw error;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        missing = true;
        return "data:,";
      }
      throw error;
    }
  }
  async function css(value: string): Promise<string> {
    let result = value;
    for (const match of [...value.matchAll(/url\(\s*["']?([^\s)"']+)["']?\s*\)/gi)].toReversed()) {
      const replacement = match[1].startsWith("data:") ? match[1] : await asset(match[1]);
      const at = match.index;
      result = result.slice(0, at) + `url("${replacement}")` + result.slice(at + match[0].length);
    }
    return result;
  }
  let html = input;
  for (const match of [
    ...input.matchAll(/<link\b[^>]*href="([a-zA-Z0-9_.-]+\.css)"[^>]*>/gi),
  ].toReversed()) {
    const content = await css((await localAsset(root, match[1])).toString("utf8"));
    html =
      html.slice(0, match.index) +
      `<style>${content}</style>` +
      html.slice(match.index + match[0].length);
  }
  // The reader supplies its own CSP and has scripts disabled; tabs are native React controls.
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  for (const match of [
    ...html.matchAll(/(<(?:img|source)\b[^>]*\bsrc=")([^"]+)(")/gi),
  ].toReversed()) {
    const replacement = match[2].startsWith("data:") ? match[2] : await asset(match[2]);
    html =
      html.slice(0, match.index) +
      match[1] +
      replacement +
      match[3] +
      html.slice(match.index + match[0].length);
  }
  // Inline styles can also refer to generated assets.
  for (const match of [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].toReversed()) {
    const content = await css(match[1]);
    html =
      html.slice(0, match.index) +
      `<style>${content}</style>` +
      html.slice(match.index + match[0].length);
  }
  if (Buffer.byteLength(html) > 12 * 1024 * 1024) throw new OfficePreviewError("PREVIEW_TOO_LARGE");
  return { html, missing };
}

export async function renderOfficeFile(
  file: string,
  output: string,
  kind: "docx" | "xlsx",
  signal: AbortSignal,
): Promise<OfficeRenderResult> {
  if (process.platform !== "darwin") throw new OfficePreviewError("UNSUPPORTED_HOST");
  await fs.mkdir(output, { mode: 0o700 });
  try {
    await exec("/usr/bin/qlmanage", ["-p", "-o", output, file], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      signal,
    });
  } catch {
    throw new OfficePreviewError("RENDER_FAILED");
  }
  const root = path.join(output, path.basename(file) + ".qlpreview");
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(root)) !== root)
    throw new OfficePreviewError("INVALID_OUTPUT");
  const preview = (await localAsset(root, "Preview.html")).toString("utf8");
  if (kind === "docx") {
    const result = await bundleQuickLookHtml(root, preview);
    return {
      content: { kind: "word", html: result.html, renderer: "macos-quicklook" },
      missingResources: result.missing,
    };
  }
  const tabs = quickLookSheetTabs(preview);
  const sheets = [];
  let missing = false;
  for (const tab of tabs) {
    const result = await bundleQuickLookHtml(
      root,
      (await localAsset(root, tab.file)).toString("utf8"),
    );
    missing ||= result.missing;
    sheets.push({ name: tab.name, html: result.html });
  }
  return {
    content: { kind: "workbook", sheets, renderer: "macos-quicklook" },
    missingResources: missing,
  };
}
