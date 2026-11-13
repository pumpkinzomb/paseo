import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentPreviewArtifactSchema } from "@getpaseo/plugin";
import { publishPreview, validateExportUrl } from "./publish";
import { validateOfficeArchive } from "./office-zip";
import { quickLookSheetTabs } from "./office-render";
import { officeZip, tinyPdf } from "../test/zip";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-preview-publish-"));
  roots.push(root);
  return root;
}
it("publishes actual PDF bytes and a typed manifest, never a text recreation", async () => {
  const cwd = await workspace();
  const bytes = tinyPdf();
  await writeFile(path.join(cwd, "test.pdf"), bytes);
  const result = await publishPreview({
    cwd,
    title: "Original file",
    sourceUrl: null,
    format: "pdf",
    source: { kind: "workspace-file", path: "test.pdf" },
    signal: new AbortController().signal,
  });
  const artifact = DocumentPreviewArtifactSchema.parse(
    JSON.parse(await readFile(result.path, "utf8")),
  );
  expect(artifact.content.kind).toBe("pdf");
  if (artifact.content.kind !== "pdf") throw Error("Expected PDF");
  expect(await readFile(path.join(path.dirname(result.path), artifact.content.asset))).toEqual(
    bytes,
  );
  expect(artifact.content.renderer).toBe("original-pdf");
  expect(result.path.endsWith(".paseoview")).toBe(true);
});
it("downloads only verified export origins without redirects and never stores the signed URL", async () => {
  const cwd = await workspace();
  const fetcher = vi.fn(
    async () => new Response(tinyPdf(), { headers: { "content-type": "application/pdf" } }),
  );
  vi.stubGlobal("fetch", fetcher);
  const url = "https://unit.oaiusercontent.com/files/test/raw?sig=transient-private-capability";
  const result = await publishPreview({
    cwd,
    title: "PDF",
    sourceUrl: null,
    format: "pdf",
    source: { kind: "export", url },
    signal: new AbortController().signal,
  });
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error" }));
  expect(await readFile(result.path, "utf8")).not.toContain("transient-private-capability");
});
it.each([
  "http://unit.oaiusercontent.com/files/a",
  "https://127.0.0.1/files/a",
  "https://oaiusercontent.com.evil.example/files/a",
  "https://user@unit.oaiusercontent.com/files/a",
  "https://unit.oaiusercontent.com:444/files/a",
])("rejects unsafe export URL %s", (value) => {
  expect(() => validateExportUrl(value)).toThrow();
});
it("rejects non-PDF bytes instead of relabelling HTML", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "bad.pdf"), "<script>data</script>");
  await expect(
    publishPreview({
      cwd,
      title: "bad",
      sourceUrl: null,
      format: "pdf",
      source: { kind: "workspace-file", path: "bad.pdf" },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("INVALID_FILE");
});
it("does not follow source symlinks outside the agent workspace", async () => {
  const cwd = await workspace(),
    outside = await workspace();
  await writeFile(path.join(outside, "private.pdf"), tinyPdf());
  await symlink(path.join(outside, "private.pdf"), path.join(cwd, "alias.pdf"));
  await expect(
    publishPreview({
      cwd,
      title: "bad",
      sourceUrl: null,
      format: "pdf",
      source: { kind: "workspace-file", path: "alias.pdf" },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("OUTSIDE_WORKSPACE");
});
it("does not persist partial publication when downloads exceed the size budget", async () => {
  const cwd = await workspace();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { headers: { "content-length": "999999999" } })),
  );
  await expect(
    publishPreview({
      cwd,
      title: "big",
      sourceUrl: null,
      format: "pdf",
      source: { kind: "export", url: "https://unit.oaiusercontent.com/files/a" },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("FILE_TOO_LARGE");
  expect(await readdir(path.join(cwd, ".paseo-document-previews"))).toEqual([]);
});
it("extracts all generated workbook tabs in order", () => {
  const html =
    '<div class="TabHeader">First &amp; total</div><a href="Attachment8.html"></a><div class="TabHeader">둘째</div><a href="Attachment3.html"></a>';
  expect(quickLookSheetTabs(html)).toEqual([
    { name: "First & total", file: "Attachment8.html" },
    { name: "둘째", file: "Attachment3.html" },
  ]);
  expect(() => quickLookSheetTabs("unexpected output")).toThrow("INVALID_OUTPUT");
});
it("validates bounded Office ZIPs and rejects external resources, macros and path traversal", async () => {
  const base = { "[Content_Types].xml": "<Types/>", "word/document.xml": "<document/>" };
  await expect(validateOfficeArchive(officeZip(base), "docx")).resolves.toBeUndefined();
  for (const extra of [
    {
      "word/_rels/document.xml.rels":
        '<Relationships><Relationship TargetMode="External" Target="https://example.invalid/private"/></Relationships>',
    },
    { "word/vbaProject.bin": "macro" },
    { "../escape.xml": "x" },
  ]) {
    await expect(validateOfficeArchive(officeZip({ ...base, ...extra }), "docx")).rejects.toThrow();
  }
});
it.runIf(process.platform === "darwin")(
  "renders actual DOCX styling/table and XLSX tabs/merges/colors/cached values through Quick Look",
  async () => {
    const cwd = await workspace();
    for (const format of ["docx", "xlsx"] as const) {
      const name = format === "docx" ? "document.docx" : "workbook.xlsx";
      await writeFile(
        path.join(cwd, name),
        await readFile(new URL("../test/" + name, import.meta.url)),
      );
      const result = await publishPreview({
        cwd,
        title: name,
        sourceUrl: null,
        format,
        source: { kind: "workspace-file", path: name },
        signal: new AbortController().signal,
      });
      const artifact = DocumentPreviewArtifactSchema.parse(
        JSON.parse(await readFile(result.path, "utf8")),
      );
      if (format === "docx") {
        expect(artifact.content.kind).toBe("word");
        if (artifact.content.kind !== "word") throw Error("Expected Word");
        expect(artifact.content.html).toContain("Document rendering test");
        expect(artifact.content.html).toContain("<table");
        expect(artifact.content.html).toContain("Second page content");
      } else {
        expect(artifact.content.kind).toBe("workbook");
        if (artifact.content.kind !== "workbook") throw Error("Expected workbook");
        expect(artifact.content.sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Detail"]);
        expect(artifact.content.sheets[0].html).toContain('colspan="3"');
        expect(artifact.content.sheets[0].html).toContain("#2458a6");
        expect(artifact.content.sheets[0].html).toContain("24000");
        expect(artifact.content.sheets[1].html).toContain("1234");
        expect(artifact.content.sheets[0].html).not.toContain("<script");
      }
    }
  },
  30_000,
);

it("rejects UTF-16 and entity-encoded external Office relationships", async () => {
  const base = { "[Content_Types].xml": "<Types/>", "word/document.xml": "<document/>" };
  const xml =
    '<Relationships><Relationship TargetMode="Extern&#x61;l" Target="https://example.invalid/"/></Relationships>';
  for (const content of [
    xml,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]),
  ]) {
    await expect(
      validateOfficeArchive(
        officeZip({ ...base, "word/_rels/document.xml.rels": content }),
        "docx",
      ),
    ).rejects.toThrow("ACTIVE_OFFICE_CONTENT");
  }
});

it.each([
  ["document", "docx", "word/document.xml"],
  ["spreadsheets", "xlsx", "xl/workbook.xml"],
  ["presentation", "pptx", "ppt/presentation.xml"],
] as const)("keeps %s PDF preview separate from actual %s original", async (kind, format, part) => {
  const cwd = await workspace();
  const pdf = tinyPdf();
  const original = officeZip({
    "[Content_Types].xml": "<Types/>",
    [part]: "<document>Editable original</document>",
    "_rels/.rels":
      '<Relationships><Relationship TargetMode="External" Target="https://example.test"/></Relationships>',
  });
  await writeFile(path.join(cwd, "preview.pdf"), pdf);
  await writeFile(path.join(cwd, `original.${format}`), original);
  const result = await publishPreview({
    cwd,
    title: "Editable file",
    sourceUrl: `https://docs.google.com/${kind}/d/fixture/edit`,
    format: "pdf",
    source: { kind: "workspace-file", path: "preview.pdf" },
    original: { format, source: { kind: "workspace-file", path: `original.${format}` } },
    signal: new AbortController().signal,
  });
  const artifact = DocumentPreviewArtifactSchema.parse(
    JSON.parse(await readFile(result.path, "utf8")),
  );
  expect(artifact.content.kind).toBe("pdf");
  expect(artifact.download?.format).toBe(format);
  if (artifact.content.kind !== "pdf" || !artifact.download) throw Error("Missing separate assets");
  const directory = path.dirname(result.path);
  expect(await readFile(path.join(directory, artifact.content.asset))).toEqual(pdf);
  expect(await readFile(path.join(directory, artifact.download.asset))).toEqual(original);
  expect(artifact.download.asset).not.toBe(artifact.content.asset);
});
it("does not label a native Google document PDF as its Word original", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "preview.pdf"), tinyPdf());
  await expect(
    publishPreview({
      cwd,
      title: "Missing Word",
      sourceUrl: "https://docs.google.com/document/d/fixture/edit",
      format: "pdf",
      source: { kind: "workspace-file", path: "preview.pdf" },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("ORIGINAL_REQUIRED");
});
it("rejects PDF bytes renamed to docx", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "preview.pdf"), tinyPdf());
  await writeFile(path.join(cwd, "fake.docx"), tinyPdf());
  await expect(
    publishPreview({
      cwd,
      title: "Bad original",
      sourceUrl: "https://docs.google.com/document/d/fixture/edit",
      format: "pdf",
      source: { kind: "workspace-file", path: "preview.pdf" },
      original: { format: "docx", source: { kind: "workspace-file", path: "fake.docx" } },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("INVALID_FILE");
});
it("download-only Office files do not weaken rendering validation", async () => {
  const bytes = officeZip({
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": "<presentation/>",
    "ppt/embeddings/chart.xlsx": "embedded chart",
    "ppt/_rels/presentation.xml.rels":
      '<Relationship TargetMode="External" Target="https://example.test"/>',
  });
  await expect(validateOfficeArchive(bytes, "pptx")).rejects.toThrow("ACTIVE_OFFICE_CONTENT");
  await expect(
    validateOfficeArchive(bytes, "pptx", { purpose: "download" }),
  ).resolves.toBeUndefined();
});
