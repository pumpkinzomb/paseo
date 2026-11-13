import type { DocumentPreviewArtifact } from "@getpaseo/plugin";
import { expect, it } from "vitest";
import {
  isManagedPreviewPath,
  parseDocumentPreview,
  previewPdfPath,
  staticOfficeDocument,
} from "./model";
const PDF_ASSET = `${"a".repeat(64)}.pdf`;
const artifact: DocumentPreviewArtifact = {
  version: 1,
  title: "Document",
  sourceUrl: null,
  originalName: PDF_ASSET,
  capturedAt: "2026-11-13T00:00:00.000Z",
  warnings: [],
  content: {
    kind: "pdf",
    asset: PDF_ASSET,
    renderer: "original-pdf",
  },
};
it("accepts a typed original-file artifact, not arbitrary JSON or text snapshots", () => {
  expect(parseDocumentPreview(JSON.stringify(artifact))).toEqual(artifact);
  expect(parseDocumentPreview("# Plain text")).toBeNull();
  expect(parseDocumentPreview(JSON.stringify({ ...artifact, version: 2 }))).toBeNull();
});
it("rejects asset traversal and noncanonical original URLs", () => {
  expect(
    parseDocumentPreview(
      JSON.stringify({
        ...artifact,
        content: { ...artifact.content, asset: "../private.pdf" },
      }),
    ),
  ).toBeNull();
  expect(
    parseDocumentPreview(
      JSON.stringify({
        ...artifact,
        sourceUrl: "https://evil.test/document/d/abc/edit",
      }),
    ),
  ).toBeNull();
  expect(previewPdfPath("/work/.paseo-document-previews/a.paseoview", "../private.pdf")).toBeNull();
  expect(previewPdfPath("/work/a.paseoview", PDF_ASSET)).toBe(`/work/${PDF_ASSET}`);
});
it("recognizes only managed artifact names", () => {
  expect(isManagedPreviewPath(`/work/.paseo-document-previews/${"b".repeat(64)}.paseoview`)).toBe(
    true,
  );
  expect(isManagedPreviewPath("/work/document.paseoview")).toBe(false);
});
it("blocks scripts and networking and bounds document zoom", () => {
  expect(staticOfficeDocument("<table></table>", 100)).toContain("zoom:2");
  expect(staticOfficeDocument("<table></table>", 0)).toContain("zoom:0.5");
  expect(staticOfficeDocument("", 1)).toContain("connect-src 'none'");
  expect(staticOfficeDocument("", 1)).toContain("script-src 'none'");
});

it("only resolves hashed original Office/PDF files beside the manifest", async () => {
  const { previewOriginalPath, previewDownloadName } = await import("./model");
  expect(previewOriginalPath("/work/a.paseoview", `${"a".repeat(64)}.xlsx`)).toBe(
    `/work/${"a".repeat(64)}.xlsx`,
  );
  expect(previewOriginalPath("/work/a.paseoview", "../private.pdf")).toBeNull();
  expect(previewOriginalPath("/work/a.paseoview", "https://evil.test/file.pdf")).toBeNull();
  expect(previewDownloadName("My / document", "pdf")).toBe("My _ document.pdf");
});

it("never downloads a legacy Google Doc PDF as an editable Word original", async () => {
  const { originalDownloadDescriptor } = await import("./model");
  const legacy = { ...artifact, sourceUrl: "https://docs.google.com/document/d/fixture/edit" };
  expect(originalDownloadDescriptor(legacy)).toBeNull();
  const word = {
    ...legacy,
    download: { asset: `${"b".repeat(64)}.docx`, format: "docx" as const },
  };
  expect(originalDownloadDescriptor(word)).toEqual(word.download);
  expect(
    parseDocumentPreview(JSON.stringify({ ...legacy, download: artifact.content })),
  ).toBeNull();
});
it("accepts real PPTX download metadata while the preview stays PDF", async () => {
  const { originalDownloadDescriptor } = await import("./model");
  const slide = {
    ...artifact,
    sourceUrl: "https://docs.google.com/presentation/d/fixture/edit",
    download: { asset: `${"c".repeat(64)}.pptx`, format: "pptx" as const },
  };
  expect(parseDocumentPreview(JSON.stringify(slide))).toEqual(slide);
  expect(originalDownloadDescriptor(slide)).toEqual(slide.download);
});
