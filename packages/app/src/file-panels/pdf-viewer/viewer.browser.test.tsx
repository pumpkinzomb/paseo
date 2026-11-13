import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { waitFor, within } from "@testing-library/dom";
import { i18n } from "@/i18n/i18next";
import { pdfRuntimeVersion } from "./runtime/html.gen";
import { PdfViewer } from "./viewer.web";
import { DocumentFrame } from "../document-frame/index.web";
const key = "paseo.pdf-viewer.preferences.v1";
let root: Root | null = null;
let container: HTMLDivElement;
let messages: Record<string, unknown>[] = [];
const urls: string[] = [];
function fixture(text = "PDF host preview") {
  const stream = `BT /F1 20 Tf 72 760 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
function blob(text: string, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  urls.push(url);
  return url;
}
function receive(event: MessageEvent) {
  if (event.source === container.querySelector("iframe")?.contentWindow) messages.push(event.data);
}
function render(url: string) {
  act(() => root?.render(<DocumentFrame url={url} testID="test-pdf-frame" />));
}
beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  expect(typeof PdfViewer).toBe("function");
  expect(pdfRuntimeVersion).toBe("6.5.438");
  localStorage.removeItem(key);
  messages = [];
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  container.style.cssText = "display:flex;width:646px;height:700px";
  document.body.append(container);
  root = createRoot(container);
  window.addEventListener("message", receive);
});
afterEach(() => {
  window.removeEventListener("message", receive);
  act(() => root?.unmount());
  container.remove();
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  localStorage.removeItem(key);
  vi.restoreAllMocks();
});
it("routes real PDF bytes into an opaque local renderer with a narrow default", async () => {
  render(blob(fixture()));
  await waitFor(
    () => expect(messages.some((message) => message.type === "pdf-rendered")).toBe(true),
    { timeout: 20000 },
  );
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(messages.find((message) => message.type === "pdf-loaded")).toMatchObject({
    pages: 1,
    width: 110,
  });
  expect(frame?.getAttribute("srcdoc")).toContain("connect-src 'none'");
  expect(frame?.getAttribute("srcdoc")).not.toContain("'unsafe-eval'");
});
it("persists only validated preferences from its own frame and restores them", async () => {
  render(blob(fixture()));
  await waitFor(
    () => expect(messages.some((message) => message.type === "pdf-loaded")).toBe(true),
    { timeout: 20000 },
  );
  const frame = container.querySelector("iframe");
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window,
      data: { type: "pdf-preferences", preferences: { width: 180, collapsed: false } },
    }),
  );
  expect(localStorage.getItem(key)).toBeNull();
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame?.contentWindow,
      data: { type: "pdf-preferences", preferences: { width: NaN, collapsed: false } },
    }),
  );
  expect(localStorage.getItem(key)).toBeNull();
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame?.contentWindow,
      data: { type: "pdf-preferences", preferences: { width: 118, collapsed: false } },
    }),
  );
  expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual({ width: 118, collapsed: false });
  act(() => root?.unmount());
  root = createRoot(container);
  messages = [];
  render(blob(fixture()));
  await waitFor(
    () =>
      expect(messages.find((message) => message.type === "pdf-loaded")).toMatchObject({
        width: 118,
      }),
    { timeout: 20000 },
  );
});
it("shows an explicit damaged-PDF error, then recovers when the file changes", async () => {
  render(blob("not a PDF"));
  await waitFor(
    () => expect(within(container).getByRole("alert").textContent).toContain("Could not render"),
    { timeout: 20000 },
  );
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  act(() => within(container).getByRole("button", { name: "Open original viewer" }).click());
  expect(open).toHaveBeenCalledOnce();
  render(blob(fixture("Recovered PDF")));
  await waitFor(
    () => expect(messages.some((message) => message.type === "pdf-rendered")).toBe(true),
    { timeout: 20000 },
  );
  expect(within(container).queryByRole("alert")).toBeNull();
});
it("keeps non-PDF documents fully sandboxed", async () => {
  render(blob("<h1>Not a PDF</h1>", "text/html"));
  await waitFor(() => expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(""));
  expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toBeNull();
});
