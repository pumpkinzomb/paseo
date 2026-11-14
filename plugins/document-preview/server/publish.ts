import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DocumentPreviewArtifactSchema,
  googleDocumentDownloadFormat,
  DOCUMENT_PREVIEW_MAX_BYTES,
  type DocumentPreviewArtifact,
} from "@getpaseo/plugin";
import { normalizeSourceUrl } from "./snapshot.js";
import { validateOfficeArchive } from "./office-zip.js";
import { OfficePreviewError, renderOfficeFile } from "./office-render.js";

export class PreviewPublishError extends Error {
  constructor(
    public readonly code:
      | "UNSUPPORTED_EXPORT_URL"
      | "DOWNLOAD_FAILED"
      | "FILE_TOO_LARGE"
      | "INVALID_FILE"
      | "OUTSIDE_WORKSPACE"
      | "INVALID_CACHE"
      | "RENDER_FAILED"
      | "UNSUPPORTED_HOST"
      | "ORIGINAL_REQUIRED"
      | "ORIGINAL_FORMAT_MISMATCH",
  ) {
    super(code);
    this.name = "PreviewPublishError";
  }
}
const MAX_FILE_BYTES = 20 * 1024 * 1024;
export interface PublishPreviewInput {
  cwd: string;
  /** Host-selected managed task directory; never a tool input. */
  outputDirectory?: string;
  title: string;
  sourceUrl: string | null;
  format: "pdf" | "docx" | "xlsx";
  source: { kind: "export"; url: string } | { kind: "workspace-file"; path: string };
  signal: AbortSignal;
  original?: { format: "docx" | "xlsx" | "pptx"; source: PublishPreviewInput["source"] };
}
export function validateExportUrl(value: string): string {
  const url = new URL(value);
  const owned = url.hostname.endsWith(".oaiusercontent.com") && url.pathname.startsWith("/files/");
  if (url.protocol !== "https:" || !owned || url.port || url.username || url.password || url.hash)
    throw new PreviewPublishError("UNSUPPORTED_EXPORT_URL");
  return url.href;
}
async function fetchExportBytes(url: string, signal: AbortSignal): Promise<Buffer> {
  let response;
  try {
    response = await fetch(validateExportUrl(url), {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch (error) {
    if (error instanceof PreviewPublishError) throw error;
    throw new PreviewPublishError("DOWNLOAD_FAILED");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new PreviewPublishError("DOWNLOAD_FAILED");
  }
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_FILE_BYTES) {
    await response.body.cancel();
    throw new PreviewPublishError("FILE_TOO_LARGE");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new PreviewPublishError("FILE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PreviewPublishError) throw error;
    throw new PreviewPublishError("DOWNLOAD_FAILED");
  }
  return Buffer.concat(chunks);
}
async function originalBytes(
  input: Pick<PublishPreviewInput, "source" | "signal">,
  root: string,
): Promise<Buffer> {
  if (input.source.kind === "export") return fetchExportBytes(input.source.url, input.signal);
  const candidate = path.resolve(root, input.source.path);
  const file = await fs.realpath(candidate);
  if (!file.startsWith(root + path.sep)) throw new PreviewPublishError("OUTSIDE_WORKSPACE");
  const info = await fs.lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new PreviewPublishError("INVALID_FILE");
  if (info.size > MAX_FILE_BYTES) throw new PreviewPublishError("FILE_TOO_LARGE");
  const bytes = await fs.readFile(file, { signal: input.signal });
  if (bytes.length > MAX_FILE_BYTES) throw new PreviewPublishError("FILE_TOO_LARGE");
  return bytes;
}
async function atomicFile(file: string, bytes: string | Buffer, signal: AbortSignal) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600, signal });
    signal.throwIfAborted();
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function prepareOriginalDownload(
  input: PublishPreviewInput,
  root: string,
  cache: string,
  previewName: string,
): Promise<NonNullable<DocumentPreviewArtifact["download"]>> {
  const expected = googleDocumentDownloadFormat(input.sourceUrl);
  const format = input.original?.format ?? input.format;
  if (expected && format !== expected)
    throw new PreviewPublishError(
      input.original ? "ORIGINAL_FORMAT_MISMATCH" : "ORIGINAL_REQUIRED",
    );
  if (!input.original) return { asset: previewName, format: input.format };
  if (input.format !== "pdf") throw new PreviewPublishError("ORIGINAL_FORMAT_MISMATCH");
  const bytes = await originalBytes({ source: input.original.source, signal: input.signal }, root);
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    throw new PreviewPublishError("INVALID_FILE");
  // Download-only bytes never enter Quick Look. Preserve legitimate links/embedded Office charts.
  await validateOfficeArchive(bytes, input.original.format, { purpose: "download" });
  const asset = createHash("sha256").update(bytes).digest("hex") + "." + input.original.format;
  await atomicFile(path.join(cache, asset), bytes, input.signal);
  return { asset, format: input.original.format };
}
export async function publishPreview(input: PublishPreviewInput) {
  const root = await fs.realpath(input.cwd);
  const sourceUrl = input.sourceUrl === null ? null : normalizeSourceUrl(input.sourceUrl);
  const outputRoot = input.outputDirectory ? await fs.realpath(input.outputDirectory) : root;
  if (outputRoot !== root && !outputRoot.startsWith(root + path.sep))
    throw new PreviewPublishError("OUTSIDE_WORKSPACE");
  const cache = path.join(outputRoot, ".paseo-document-previews");
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(cache);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(cache)) !== cache)
    throw new PreviewPublishError("INVALID_CACHE");
  const bytes = await originalBytes(input, root);
  if (
    input.format === "pdf"
      ? !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
      : !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  )
    throw new PreviewPublishError("INVALID_FILE");
  if (input.format !== "pdf") await validateOfficeArchive(bytes, input.format);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const originalName = digest + "." + input.format;
  const original = path.join(cache, originalName);
  const download = await prepareOriginalDownload(
    { ...input, sourceUrl },
    root,
    cache,
    originalName,
  );
  await atomicFile(original, bytes, input.signal);
  let content: DocumentPreviewArtifact["content"];
  const warnings: DocumentPreviewArtifact["warnings"] = [];
  if (input.format === "pdf")
    content = { kind: "pdf", asset: originalName, renderer: "original-pdf" };
  else {
    const temporary = await fs.mkdtemp(path.join(cache, ".render-"));
    try {
      const result = await renderOfficeFile(
        original,
        path.join(temporary, "output"),
        input.format,
        input.signal,
      );
      content = result.content;
      warnings.push("native-renderer");
      if (result.missingResources) warnings.push("missing-resources");
    } catch (error) {
      if (error instanceof OfficePreviewError && error.code === "UNSUPPORTED_HOST") {
        await fs.rm(temporary, { recursive: true });
        throw new PreviewPublishError("UNSUPPORTED_HOST");
      }
      // An uncertain native converter job is not permission to kill Quick Look or remove its output.
      throw new PreviewPublishError("RENDER_FAILED");
    }
    await fs.rm(temporary, { recursive: true });
  }
  const artifact = DocumentPreviewArtifactSchema.parse({
    version: 1,
    title: input.title,
    sourceUrl,
    originalName,
    download,
    capturedAt: new Date().toISOString(),
    warnings,
    content,
  });
  const json = JSON.stringify(artifact);
  if (Buffer.byteLength(json) > DOCUMENT_PREVIEW_MAX_BYTES)
    throw new PreviewPublishError("FILE_TOO_LARGE");
  const identity = createHash("sha256")
    .update(sourceUrl ?? input.source.kind + ":" + input.title)
    .digest("hex");
  const file = path.join(cache, identity + ".paseoview");
  await atomicFile(file, json, input.signal);
  return {
    path: file,
    title: input.title,
    format: input.format,
    downloadFormat: download.format,
    renderer: content.renderer,
    sheetCount: content.kind === "workbook" ? content.sheets.length : null,
  };
}
