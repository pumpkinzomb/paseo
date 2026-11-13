import { z } from "zod";

export const DOCUMENT_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const html = z
  .string()
  .min(1)
  .max(12 * 1024 * 1024);
const googleSource = z
  .string()
  .regex(
    /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/[a-zA-Z0-9_-]+\/edit$/,
  );

export type DocumentDownloadFormat = "pdf" | "docx" | "xlsx" | "pptx";
export function googleDocumentDownloadFormat(
  sourceUrl: string | null,
): DocumentDownloadFormat | null {
  const kind = sourceUrl?.match(
    /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\//,
  )?.[1];
  const formats: Record<string, DocumentDownloadFormat> = {
    document: "docx",
    spreadsheets: "xlsx",
    presentation: "pptx",
  };
  return kind ? (formats[kind] ?? null) : null;
}
export const DocumentOriginalDownloadSchema = z
  .object({
    asset: z.string().regex(/^[a-f0-9]{64}\.(pdf|docx|xlsx|pptx)$/),
    format: z.enum(["pdf", "docx", "xlsx", "pptx"]),
  })
  .refine(
    (value) => value.asset.endsWith(`.${value.format}`),
    "Download asset must match its actual format",
  );
/** A cached file rendering, never an editable Office document or a live Google session. */
export const DocumentPreviewArtifactSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(256),
    sourceUrl: googleSource.nullable(),
    // Legacy preview input asset; a PDF preview is not an editable Office original.
    originalName: z.string().min(1).max(512),
    capturedAt: z.iso.datetime(),
    download: DocumentOriginalDownloadSchema.optional(),
    warnings: z.array(z.enum(["missing-resources", "native-renderer"])).max(2),
    content: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("pdf"),
        asset: z.string().regex(/^[a-f0-9]{64}\.pdf$/),
        renderer: z.literal("original-pdf"),
      }),
      z.object({ kind: z.literal("word"), html, renderer: z.literal("macos-quicklook") }),
      z.object({
        kind: z.literal("workbook"),
        sheets: z
          .array(z.object({ name: z.string().min(1).max(256), html }))
          .min(1)
          .max(100),
        renderer: z.literal("macos-quicklook"),
      }),
    ]),
  })
  .refine(
    (value) =>
      !value.download ||
      !googleDocumentDownloadFormat(value.sourceUrl) ||
      value.download.format === googleDocumentDownloadFormat(value.sourceUrl),
    "Google native download must use its editable Office export format",
  );
export type DocumentPreviewArtifact = z.infer<typeof DocumentPreviewArtifactSchema>;
