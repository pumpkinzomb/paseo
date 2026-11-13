import { expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfPrintLimitError, printPdfDocument } from "./print";
it("rejects an oversized print job before allocating DOM/canvases", async () => {
  const pdf = { numPages: 201 } as PDFDocumentProxy;
  await expect(printPdfDocument(pdf, new AbortController().signal)).rejects.toBeInstanceOf(
    PdfPrintLimitError,
  );
});
it("bounds prepared pixels before rendering any pages", async () => {
  const getPage = vi.fn(async () => ({ getViewport: () => ({ width: 16000, height: 16000 }) }));
  const pdf = { numPages: 2, getPage } as unknown as PDFDocumentProxy;
  await expect(printPdfDocument(pdf, new AbortController().signal)).rejects.toBeInstanceOf(
    PdfPrintLimitError,
  );
  expect(getPage).toHaveBeenCalledOnce();
});
it("a closed or changed document cannot start printing", async () => {
  const getPage = vi.fn();
  const controller = new AbortController();
  controller.abort();
  const pdf = { numPages: 1, getPage } as unknown as PDFDocumentProxy;
  await expect(printPdfDocument(pdf, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(getPage).not.toHaveBeenCalled();
});
