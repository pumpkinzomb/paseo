import {
  DocumentPreviewArtifactSchema,
  DOCUMENT_PREVIEW_MAX_BYTES,
  type DocumentPreviewArtifact,
  googleDocumentDownloadFormat,
  type DocumentDownloadFormat,
} from "@getpaseo/plugin";
export function parseDocumentPreview(text: string): DocumentPreviewArtifact | null {
  if (new TextEncoder().encode(text).length > DOCUMENT_PREVIEW_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = DocumentPreviewArtifactSchema.safeParse(value);
  return result.success ? result.data : null;
}
export function isManagedPreviewPath(path: string): boolean {
  const normalized = path.replaceAll(String.fromCharCode(92), "/");
  const parts = normalized.split("/");
  return (
    parts.at(-2) === ".paseo-document-previews" &&
    /^[a-f0-9]{64}\.paseoview$/.test(parts.at(-1) ?? "")
  );
}
export function previewPdfPath(manifestPath: string, asset: string): string | null {
  if (!/^[a-f0-9]{64}\.pdf$/.test(asset)) return null;
  const normalized = manifestPath.replaceAll(String.fromCharCode(92), "/");
  return normalized.slice(0, normalized.lastIndexOf("/") + 1) + asset;
}
export const OFFICE_PREVIEW_POLICY =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
export function staticOfficeDocument(html: string, zoom: number): string {
  const scale = Math.max(0.5, Math.min(2, zoom));
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${OFFICE_PREVIEW_POLICY}"><meta charset="utf-8"><style>html{zoom:${scale}}body{background:white;color:black}</style>${html}`;
}
export function previewOriginalPath(manifestPath: string, originalName: string): string | null {
  if (!/^[a-f0-9]{64}\.(pdf|docx|xlsx|pptx)$/.test(originalName)) return null;
  const normalized = manifestPath.replaceAll(String.fromCharCode(92), "/");
  return normalized.slice(0, normalized.lastIndexOf("/") + 1) + originalName;
}
export function previewDownloadName(title: string, extension: string): string {
  const name = Array.from(title, (character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  const base = name || "document";
  const suffix = `.${extension}`;
  return base.toLowerCase().endsWith(suffix.toLowerCase()) ? base : base + suffix;
}

export function originalDownloadDescriptor(
  artifact: DocumentPreviewArtifact,
): { asset: string; format: DocumentDownloadFormat } | null {
  const expected = googleDocumentDownloadFormat(artifact.sourceUrl);
  if (artifact.download) {
    if (expected && artifact.download.format !== expected) return null;
    return artifact.download;
  }
  const formats = { pdf: "pdf", word: "docx", workbook: "xlsx" } as const;
  const format = formats[artifact.content.kind];
  if (expected && format !== expected) return null;
  const match = artifact.originalName.match(/^([a-f0-9]{64})\.(pdf|docx|xlsx|pptx)$/);
  if (!match || match[2] !== format) return null;
  if (artifact.content.kind === "pdf" && artifact.content.asset !== artifact.originalName)
    return null;
  return { asset: artifact.originalName, format };
}
