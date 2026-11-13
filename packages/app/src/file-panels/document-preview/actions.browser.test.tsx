import React, { act, useContext, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { within, waitFor } from "@testing-library/dom";
import { i18n } from "@/i18n/i18next";
import type { DocumentPreviewArtifact } from "@getpaseo/plugin";
import { PdfPrintActionContext } from "../pdf-viewer/actions";
import { DocumentPreviewView } from "./panel";
import { downloadPreviewFile } from "./download.web";
const mocks = vi.hoisted(() => ({ open: vi.fn(), print: vi.fn() }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: mocks.open }));
let root: Root | null = null;
let container: HTMLDivElement;
function PrintProbe() {
  const set = useContext(PdfPrintActionContext);
  useEffect(() => {
    set?.({ run: mocks.print, busy: false, ready: true });
    return () => set?.(null);
  }, [set]);
  return null;
}
const pdf = <PrintProbe />;
const artifact: DocumentPreviewArtifact = {
  version: 1,
  title: "Preview title",
  sourceUrl: "https://docs.google.com/document/d/fixture/edit",
  originalName: `${"a".repeat(64)}.pdf`,
  capturedAt: "2026-11-13T00:00:00.000Z",
  warnings: [],
  content: { kind: "pdf", asset: `${"a".repeat(64)}.pdf`, renderer: "original-pdf" },
};
beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  mocks.open.mockClear();
  mocks.print.mockClear();
  container = document.createElement("div");
  container.style.cssText = "width:646px;height:700px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});
it("uses icon actions with accessible labels and gives the title 12px left padding", async () => {
  const client = new QueryClient();
  act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <DocumentPreviewView artifact={artifact} pdf={pdf} />
      </QueryClientProvider>,
    ),
  );
  const ui = within(container);
  const original = ui.getByRole("button", { name: "Open original" });
  const print = ui.getByRole("button", { name: "Print PDF" });
  expect(original.textContent).toBe("");
  expect(print.textContent).toBe("");
  const title = ui.getByText("Preview title");
  expect(getComputedStyle(title.parentElement!).paddingLeft).toBe("12px");
  act(() => original.click());
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(artifact.sourceUrl));
  act(() => print.click());
  expect(mocks.print).toHaveBeenCalledOnce();
});
it("downloads the actual local file with a readable filename without revoking its preview URL", async () => {
  const url = URL.createObjectURL(new Blob(["actual file bytes"], { type: "application/pdf" }));
  let href = "",
    name = "";
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      href = this.href;
      name = this.download;
    });
  try {
    await downloadPreviewFile(url, "써니 문서 연결 테스트.pdf");
    expect(click).toHaveBeenCalledOnce();
    expect(href).not.toBe(url);
    expect(href.startsWith("blob:")).toBe(true);
    expect(await (await fetch(href)).text()).toBe("actual file bytes");
    expect(name).toBe("써니 문서 연결 테스트.pdf");
    expect(await (await fetch(url)).text()).toBe("actual file bytes");
    expect(document.querySelector("a[download]")).toBeNull();
  } finally {
    URL.revokeObjectURL(url);
    if (href) URL.revokeObjectURL(href);
  }
});
it("does not turn arbitrary remote URLs into downloads", async () => {
  await expect(downloadPreviewFile("https://evil.test/file.pdf", "file.pdf")).rejects.toThrow(
    "local preview bytes",
  );
});
