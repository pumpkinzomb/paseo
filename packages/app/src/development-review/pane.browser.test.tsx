import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { within, waitFor, fireEvent } from "@testing-library/dom";
import { i18n } from "@/i18n/i18next";
import type { DevelopmentReviewIdentity } from "@/workspace/file-open";
import { DevelopmentSourceSelector, DevelopmentReviewPane, useDevelopmentSelection } from "./pane";
const host = vi.hoisted(() => ({
  parent: "parent",
  supported: true,
  missing: false,
  open: vi.fn(),
  read: vi.fn(),
  link: vi.fn(),
  extra: false,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeClient: () => ({
    getLastServerInfoMessage: () => ({ features: { developmentReview: host.supported } }),
    readDevelopmentReview: host.read,
    linkDevelopmentSource: host.link,
  }),
}));
vi.mock("@/panels/pane-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/panels/pane-context")>()),
  usePaneFocus: () => ({
    isWorkspaceFocused: true,
    isPaneFocused: true,
    isInteractive: true,
    focusPane: host.open,
  }),
  usePaneContext: () => ({
    serverId: "server",
    workspaceId: host.parent,
    openPreferredTarget: host.open,
  }),
}));
vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { codeFontSize: 13, monoFontFamily: "monospace" } }),
}));
vi.mock("@/git/diff-document", () => ({ DiffDocument: () => null }));
vi.mock("@/file-panels/source/find/index.web", async () => ({
  FileFind: () => null,
  FileFindModel: (await import("@/file-panels/source/find/model.web")).FileFindModel,
}));
vi.mock("@/hooks/use-app-visible", () => ({ useAppActivelyVisible: () => true }));
vi.mock("react-native-unistyles", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-native-unistyles")>();
  const { lightTheme } = await import("@/styles/theme");
  const react = await import("react");
  return {
    ...original,
    withUnistyles: (
      Component: React.ComponentType<Record<string, unknown>>,
      mapping?: (theme: typeof lightTheme) => Record<string, unknown>,
    ) => {
      function Themed(props: Record<string, unknown>) {
        return react.createElement(Component, { ...mapping?.(lightTheme), ...props });
      }
      return Themed;
    },
  };
});
const scopes = ["Alpha", "Beta"].map((label) => ({
  workspaceId: label,
  sourceWorkspaceId: label,
  label,
  path: `/fixture/${label}`,
  branch: "main",
  status: "live" as const,
}));
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
let parentCounter = 0;
function Shell() {
  const selected = useDevelopmentSelection("server", host.parent);
  const [pinned, setPinned] = useState<{
    path: string;
    developmentReview: DevelopmentReviewIdentity;
  }>();
  host.open.mockImplementation(setPinned);
  return (
    <>
      <DevelopmentSourceSelector />
      {selected && (
        <DevelopmentReviewPane key={JSON.stringify(selected)} selected={selected} mode="files" />
      )}
      {pinned && (
        <div data-testid="pinned-file">
          <DevelopmentReviewPane
            key={JSON.stringify(pinned)}
            selected={pinned.developmentReview}
            mode="file"
            filePath={pinned.path}
          />
        </div>
      )}
    </>
  );
}
beforeEach(async ({ task }) => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  host.parent = `parent-${parentCounter++}`;
  host.supported = !task.name.startsWith("old hosts");
  host.missing = false;
  host.extra = false;
  host.open.mockReset();
  host.read.mockReset();
  host.link.mockReset();
  host.read.mockImplementation(async (request) => {
    if (request.operation === "list") return { requestId: "list", scopes, candidates: [] };
    if (host.missing) throw new Error("Selected development scope unavailable");
    if (request.operation === "file")
      return { requestId: "file", scopes, content: `${request.scopeWorkspaceId} pinned source\n` };
    return {
      requestId: "files",
      scopes,
      entries: [
        ...(host.extra
          ? [{ name: "new.txt", path: "new.txt", kind: "file", size: 1, modifiedAt: "now" }]
          : []),
        {
          name: `${request.scopeWorkspaceId}.txt`,
          path: `${request.scopeWorkspaceId}.txt`,
          kind: "file",
          size: 1,
          modifiedAt: "now",
        },
      ],
    };
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  container.style.cssText = "width:900px;height:800px";
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={cache}>
        <Shell />
      </QueryClientProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  cache.clear();
  vi.unstubAllGlobals();
});
async function choose(name: string) {
  const ui = within(container);
  fireEvent.click(ui.getByRole("button", { name: /^Development source:/ }));
  await waitFor(() =>
    expect(ui.getByRole("button", { name: new RegExp(`^${name} ·`) })).toBeTruthy(),
  );
  fireEvent.click(ui.getByRole("button", { name: new RegExp(`^${name} ·`) }));
}
it("selects a named source and pins an opened readonly file while source choice changes", async () => {
  await choose("Alpha");
  const ui = within(container);
  await waitFor(() => expect(ui.getByRole("button", { name: "Alpha.txt" })).toBeTruthy());
  fireEvent.click(ui.getByRole("button", { name: "Alpha.txt" }));
  expect(host.open).toHaveBeenCalledWith(
    expect.objectContaining({
      developmentReview: {
        serverId: "server",
        parentWorkspaceId: host.parent,
        workspaceId: "Alpha",
      },
    }),
    "explorerFiles",
  );
  await waitFor(() =>
    expect(within(ui.getByTestId("pinned-file")).getByText(/Alpha pinned source/)).toBeTruthy(),
  );
  await choose("Beta");
  await waitFor(() => expect(ui.getByRole("button", { name: "Beta.txt" })).toBeTruthy());
  expect(within(ui.getByTestId("pinned-file")).getByText(/Alpha pinned source/)).toBeTruthy();
  expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  expect(
    host.read.mock.calls
      .filter(([request]) => request.operation === "file")
      .every(([request]) => request.scopeWorkspaceId === "Alpha"),
  ).toBe(true);
});
it("shows unavailable without falling back to conversation files", async () => {
  host.missing = true;
  await choose("Alpha");
  await waitFor(() =>
    expect(within(container).getByText(/Selected development scope unavailable/)).toBeTruthy(),
  );
  expect(within(container).queryByRole("button", { name: "Alpha.txt" })).toBeNull();
  expect(
    host.read.mock.calls.every(
      ([request]) => request.operation === "list" || request.scopeWorkspaceId === "Alpha",
    ),
  ).toBe(true);
});
it("old hosts show update guidance and send no development requests", async () => {
  host.supported = false;
  host.read.mockClear();
  act(() =>
    root.render(
      <QueryClientProvider client={cache}>
        <Shell />
      </QueryClientProvider>,
    ),
  );
  fireEvent.click(within(container).getByRole("button", { name: /^Development source:/ }));
  await waitFor(() =>
    expect(within(container).getByText("Update the host to use development review.")).toBeTruthy(),
  );
  expect(host.read).not.toHaveBeenCalled();
});

it("refreshes new files in the selected live scope without selecting it again", async () => {
  await choose("Alpha");
  await waitFor(() =>
    expect(within(container).getByRole("button", { name: "Alpha.txt" })).toBeTruthy(),
  );
  host.extra = true;
  await waitFor(
    () => expect(within(container).getByRole("button", { name: "new.txt" })).toBeTruthy(),
    { timeout: 6500 },
  );
}, 10000);
