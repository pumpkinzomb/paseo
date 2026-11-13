import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
export class PdfPrintLimitError extends Error {}
const MAX_PRINT_PAGES = 200;
const MAX_PRINT_PIXELS = 128_000_000;
const MAX_PRINT_BYTES = 64 * 1024 * 1024;
export async function printPdfDocument(pdf: PDFDocumentProxy, signal: AbortSignal): Promise<void> {
  if (pdf.numPages > MAX_PRINT_PAGES) throw new PdfPrintLimitError();
  const pages = [];
  let pixels = 0;
  for (let number = 1; number <= pdf.numPages; number++) {
    signal.throwIfAborted();
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 150 / 72 });
    pixels += Math.ceil(viewport.width) * Math.ceil(viewport.height);
    if (
      !Number.isFinite(pixels) ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      pixels > MAX_PRINT_PIXELS ||
      viewport.width > 16384 ||
      viewport.height > 16384
    )
      throw new PdfPrintLimitError();
    pages.push({ page, viewport });
  }
  signal.throwIfAborted();
  const root = document.createElement("div");
  root.id = "pdf-print-root";
  const style = document.createElement("style");
  style.textContent = `#pdf-print-root{display:none}@media print{html,body{height:auto!important;overflow:visible!important;margin:0!important;background:white!important}#pdf-root{display:none!important}#pdf-print-root{display:block!important}.pdf-print-page{margin:0;padding:0;break-after:page;break-inside:avoid}.pdf-print-page:last-child{break-after:auto}.pdf-print-page img{display:block;width:100%;height:100%}}`;
  document.head.append(style);
  document.body.append(root);
  const urls: string[] = [];
  let task: RenderTask | null = null;
  let encoded = 0;
  const abort = () => task?.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (const [index, { page, viewport }] of pages.entries()) {
      signal.throwIfAborted();
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        task = page.render({ canvas, viewport });
        await task.promise;
        signal.throwIfAborted();
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((value) => {
            if (!value) {
              reject(Error("PDF print image failed"));
              return;
            }
            resolve(value);
          }, "image/png"),
        );
        encoded += blob.size;
        if (encoded > MAX_PRINT_BYTES) throw new PdfPrintLimitError();
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const image = document.createElement("img");
        image.src = url;
        image.alt = "";
        await image.decode();
        signal.throwIfAborted();
        const pageSize = page.getViewport({ scale: 1 });
        if (!Number.isFinite(pageSize.width) || !Number.isFinite(pageSize.height))
          throw new PdfPrintLimitError();
        const name = `pdf-print-${index}`;
        style.textContent += `@page ${name}{size:${pageSize.width}pt ${pageSize.height}pt;margin:0}`;
        const section = document.createElement("section");
        section.className = "pdf-print-page";
        section.style.cssText = `page:${name};width:${pageSize.width}pt;height:${pageSize.height}pt`;
        section.append(image);
        root.append(section);
      } finally {
        task = null;
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      function cleanup() {
        window.removeEventListener("afterprint", done);
        signal.removeEventListener("abort", cancel);
      }
      function done() {
        cleanup();
        resolve();
      }
      function cancel() {
        cleanup();
        reject(signal.reason);
      }
      window.addEventListener("afterprint", done, { once: true });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        window.print();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } finally {
    signal.removeEventListener("abort", abort);
    root.remove();
    style.remove();
    for (const url of urls) URL.revokeObjectURL(url);
  }
}
