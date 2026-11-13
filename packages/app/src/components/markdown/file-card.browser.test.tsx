import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { within } from "@testing-library/dom";
import { i18n } from "@/i18n/i18next";
import { FileCard } from "./file-card";

const actions = vi.hoisted(() => ({
  open: vi.fn(),
  canOpen: vi.fn(() => true),
  canResolveFile: vi.fn(() => true),
}));
vi.mock("@/assistant-file-links", () => ({ useAssistantFileLinkActions: () => actions }));
let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(async () => {
  vi.stubGlobal("React", React);
  actions.open.mockClear();
  actions.canOpen.mockReturnValue(true);
  actions.canResolveFile.mockReturnValue(true);
  await i18n.changeLanguage("en");
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
function mount(path: string, title: string | null) {
  const node = document.createElement("div");
  container = node;
  document.body.appendChild(node);
  root = createRoot(node);
  act(() => root?.render(<FileCard path={path} title={title} />));
  return within(node);
}
it("shows a document card and opens the existing Explorer sidebar", () => {
  const ui = mount("/work/.paseo-document-previews/abc.md", "써니 문서 연결 테스트");
  const card = ui.getByRole("button", { name: "써니 문서 연결 테스트 — Open preview" });
  act(() => card.click());
  expect(actions.open).toHaveBeenCalledWith(
    {
      href: "/work/.paseo-document-previews/abc.md",
      text: "/work/.paseo-document-previews/abc.md",
    },
    "explorer",
  );
  expect(container?.textContent).not.toContain("codex-file-citation");
});
it("labels a remote original honestly instead of pretending it is a no-login preview", () => {
  actions.canResolveFile.mockReturnValue(false);
  const ui = mount("https://docs.google.com/document/d/abc/edit", null);
  const card = ui.getByRole("button", { name: "Google Docs — Open original" });
  act(() => card.click());
  expect(actions.open).toHaveBeenCalledOnce();
});
it("does not offer an unavailable file-open action", () => {
  actions.canOpen.mockReturnValue(false);
  const ui = mount("/work/a.md", "Unavailable");
  const card = ui.getByRole("button", { name: "Unavailable — Open preview" });
  act(() => card.click());
  expect(actions.open).not.toHaveBeenCalled();
});
