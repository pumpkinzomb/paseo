import React, { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { within, waitFor, fireEvent } from "@testing-library/dom";
import { i18n } from "@/i18n/i18next";
import type { DevelopmentReviewScope } from "@getpaseo/protocol/messages";
import type { DevelopmentReviewIdentity } from "@/workspace/file-open";
import { FollowingDevelopmentChanges, DevelopmentReviewPane } from "./pane";
import { filesPanelRegistration } from "@/panels/files-panel";
const host = vi.hoisted(() => ({
  parent: "parent",
  originalParent: "parent",
  server: "server",
  supported: true,
  missing: false,
  extra: false,
  open: vi.fn(),
  read: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("lucide-react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react-native")>()),
  Eye: ({ size, color }: { size: number; color: string }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  RotateCw: ({ size, color }: { size: number; color: string }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  ),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeClient: () => ({
    getLastServerInfoMessage: () => ({ features: { developmentReview: host.supported } }),
    readDevelopmentReview: host.read,
    captureDevelopmentReview: host.capture,
  }),
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceDirectory: () => `/scratch/${host.parent}`,
}));
vi.mock("@/panels/use-add-file-to-chat", () => ({
  useAddFileToChat: () => ({ canAddToChat: false, addFile: host.open }),
}));
vi.mock("@/components/file-explorer-pane", () => ({ FileExplorerPane: ConversationExplorer }));
function ConversationExplorer({
  treeHeader,
  treeFooter,
  treeExpanded = true,
  onScopeFocus,
  onOpenFile,
}: {
  treeHeader?: React.ReactNode;
  treeFooter?: React.ReactNode;
  treeExpanded?: boolean;
  onScopeFocus?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const open = useCallback(() => {
    onScopeFocus?.();
    onOpenFile?.("output.txt");
  }, [onScopeFocus, onOpenFile]);
  return (
    <div data-testid="file-explorer-tree-scroll">
      {treeHeader}
      {treeExpanded && (
        <button type="button" onClick={open}>
          output.txt
        </button>
      )}
      {treeFooter}
    </div>
  );
}
vi.mock("@/panels/pane-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/panels/pane-context")>()),
  usePaneContext: () => ({
    serverId: host.server,
    workspaceId: host.parent,
    target: { kind: "files" },
    openPreferredTarget: host.open,
  }),
}));
vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { codeFontSize: 13, monoFontFamily: "monospace" } }),
}));
vi.mock("@/git/diff-document", () => ({
  DiffDocument: ({ files }: { files: { path: string }[] }) => (
    <div data-testid="active-changes">{files.map((file) => file.path).join(",")}</div>
  ),
}));
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
        const { uniProps, ...rest } = props;
        const mapped = typeof uniProps === "function" ? uniProps(lightTheme) : undefined;
        return react.createElement(Component, { ...mapping?.(lightTheme), ...mapped, ...rest });
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
const Files = filesPanelRegistration.component;
const conversationChanges = <div data-testid="conversation-changes">Conversation changes</div>;
let root: Root;
let container: HTMLDivElement;
let cache: QueryClient;
let parentCounter = 0;
function Shell() {
  const [pinned, setPinned] = useState<{
    path: string;
    developmentReview?: DevelopmentReviewIdentity;
  }>();
  host.open.mockImplementation(setPinned);
  return (
    <>
      <Files />
      <FollowingDevelopmentChanges conversation={conversationChanges} />
      {pinned?.developmentReview && (
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
function render() {
  act(() =>
    root.render(
      <QueryClientProvider client={cache}>
        <Shell />
      </QueryClientProvider>,
    ),
  );
}
beforeEach(async ({ task }) => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  host.parent = `parent-${parentCounter++}`;
  host.originalParent = host.parent;
  host.server = "server";
  host.supported = !task.name.startsWith("old hosts");
  host.missing = false;
  host.extra = false;
  host.open.mockReset();
  host.read.mockReset();
  host.capture.mockReset();
  host.read.mockImplementation(async (request) => {
    if (request.operation === "list")
      return {
        requestId: "list",
        scopes:
          request.workspaceId === host.originalParent && host.server === "server" ? scopes : [],
      };
    if (host.missing) throw new Error("Selected development scope unavailable");
    if (request.operation === "file")
      return { requestId: "file", scopes, content: `${request.scopeWorkspaceId} pinned source\n` };
    if (request.operation === "diff")
      return {
        requestId: "diff",
        scopes,
        files: [
          {
            path: `${request.scopeWorkspaceId}.changed.ts`,
            isNew: true,
            isDeleted: false,
            additions: 1,
            deletions: 0,
            hunks: [],
          },
        ],
      };
    const entries =
      request.path === "src"
        ? [{ name: "index.ts", path: "src/index.ts", kind: "file" }]
        : [
            { name: "src", path: "src", kind: "directory" },
            {
              name: `${request.scopeWorkspaceId}.txt`,
              path: `${request.scopeWorkspaceId}.txt`,
              kind: "file",
            },
          ];
    if (host.extra && !request.path)
      entries.push({ name: "new.txt", path: "new.txt", kind: "file" });
    return {
      requestId: "files",
      scopes,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        size: 1,
        modifiedAt: "now",
      })),
    };
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  container.style.cssText = "width:900px;height:1000px";
  document.body.append(container);
  root = createRoot(container);
  render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  cache.clear();
  vi.unstubAllGlobals();
});
async function expand(name: string) {
  const ui = within(container);
  await waitFor(() =>
    expect(ui.getByRole("button", { name: new RegExp(`^${name}(?:,|$)`) })).toBeTruthy(),
  );
  act(() => fireEvent.click(ui.getByRole("button", { name: new RegExp(`^${name}(?:,|$)`) })));
}
it("expands inline groups and folders while primary Changes follows tree A to B and opened files stay pinned", async () => {
  const ui = within(container);
  await expand("Alpha");
  await waitFor(() => expect(ui.getByText("Alpha.changed.ts")).toBeTruthy());
  await expand("src");
  await waitFor(() => expect(ui.getByRole("button", { name: "index.ts" })).toBeTruthy());
  act(() => fireEvent.click(ui.getByRole("button", { name: "index.ts" })));
  await waitFor(() =>
    expect(
      within(ui.getByTestId("pinned-file")).getByLabelText("Source for src/index.ts").textContent,
    ).toContain("Alpha pinned source"),
  );
  await expand("Beta");
  await waitFor(() => expect(ui.getByText("Beta.changed.ts")).toBeTruthy());
  expect(
    within(ui.getByTestId("pinned-file")).getByLabelText("Source for src/index.ts").textContent,
  ).toContain("Alpha pinned source");
  expect(ui.getByRole("button", { name: "index.ts" })).toBeTruthy();
  expect(container.querySelectorAll('[data-testid="file-explorer-tree-scroll"]').length).toBe(1);
  expect(ui.queryByText(/Development source:/)).toBeNull();
  expect(ui.queryByText(/Link registered source/)).toBeNull();
  expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  act(() => fireEvent.click(ui.getByRole("button", { name: "output.txt" })));
  await waitFor(() => expect(ui.getByTestId("conversation-changes")).toBeTruthy());
  expect(ui.queryByTestId("active-changes")).toBeNull();
});
it("collapses the conversation group without replacing the other tree groups", async () => {
  const ui = within(container);
  await expand("Conversation outputs");
  expect(ui.queryByRole("button", { name: "output.txt" })).toBeNull();
  await expand("Alpha");
  await waitFor(() => expect(ui.getByRole("button", { name: "Alpha.txt" })).toBeTruthy());
  await expand("Conversation outputs");
  expect(ui.getByRole("button", { name: "output.txt" })).toBeTruthy();
});
it("keeps unavailable selected work unavailable instead of falling back to conversation Changes", async () => {
  host.missing = true;
  await expand("Alpha");
  await waitFor(() =>
    expect(
      within(container).getAllByText(/Selected development scope unavailable/).length,
    ).toBeGreaterThan(0),
  );
  expect(within(container).queryByTestId("conversation-changes")).toBeNull();
});
it("scopes groups and active Changes when the parent or host changes", async () => {
  await expand("Alpha");
  await waitFor(() => expect(within(container).getByText("Alpha.changed.ts")).toBeTruthy());
  host.parent = "other-parent";
  render();
  await waitFor(() =>
    expect(within(container).queryByRole("button", { name: /^Alpha(?:,|$)/ })).toBeNull(),
  );
  expect(within(container).getByTestId("conversation-changes")).toBeTruthy();
  host.parent = host.originalParent;
  host.server = "other-host";
  render();
  await waitFor(() =>
    expect(within(container).queryByRole("button", { name: /^Alpha(?:,|$)/ })).toBeNull(),
  );
  expect(within(container).getByTestId("conversation-changes")).toBeTruthy();
  expect(within(container).queryByTestId("active-changes")).toBeNull();
});
it("old hosts keep ordinary conversation Files and Changes without development requests", () => {
  expect(within(container).getByRole("button", { name: "output.txt" })).toBeTruthy();
  expect(within(container).getByTestId("conversation-changes")).toBeTruthy();
  expect(host.read).not.toHaveBeenCalled();
});
it("refreshes an expanded live folder without selecting work again", async () => {
  await expand("Alpha");
  await waitFor(() =>
    expect(within(container).getByRole("button", { name: "Alpha.txt" })).toBeTruthy(),
  );
  host.extra = true;
  await waitFor(
    () => expect(within(container).getByRole("button", { name: "new.txt" })).toBeTruthy(),
    { timeout: 6500 },
  );
}, 10000);

function renderReview(scope: DevelopmentReviewScope, changed = false) {
  host.read.mockImplementation(async () => ({
    requestId: "header",
    scopes: [scope],
    files: changed
      ? [
          {
            path: "legitimate-image.png",
            status: "binary",
            isNew: true,
            isDeleted: false,
            additions: 0,
            deletions: 0,
            hunks: [],
          },
        ]
      : [],
  }));
  const selected = {
    serverId: host.server,
    parentWorkspaceId: host.parent,
    workspaceId: scope.workspaceId,
    ...(scope.evidenceId ? { evidenceId: scope.evidenceId } : {}),
  };
  renderSelectedReview(selected);
}
function renderSelectedReview(selected: DevelopmentReviewIdentity) {
  act(() =>
    root.render(
      <QueryClientProvider client={cache}>
        <DevelopmentReviewPane selected={selected} mode="diff" />
      </QueryClientProvider>,
    ),
  );
}
it("keeps the real header balanced with single-line accessible paths at normal and narrow widths", async () => {
  const path =
    "/fixture/a-very-long-project-path/with/nested/development/workspaces/and/a-managed-task-folder";
  const label = "A long readable development task name that should truncate";
  renderReview({ ...scopes[0], label, path });
  const ui = within(container);
  await waitFor(() => expect(ui.getByText("Working folder")).toBeTruthy());
  for (const width of [480, 320, 220]) {
    container.style.width = `${width}px`;
    const header = ui.getByTestId("development-review-header");
    const title = ui.getByTestId("development-review-title");
    const pathElement = ui.getByTestId("development-review-path");
    const refresh = ui.getByRole("button", { name: "Refresh" });
    const headerBounds = header.getBoundingClientRect();
    const refreshBounds = refresh.getBoundingClientRect();
    expect(headerBounds.width).toBe(width);
    expect(headerBounds.height).toBeLessThanOrEqual(64);
    expect(title.getBoundingClientRect().height).toBeLessThanOrEqual(24);
    expect(pathElement.getBoundingClientRect().height).toBeLessThanOrEqual(24);
    expect(getComputedStyle(pathElement).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(pathElement).textOverflow).toBe("ellipsis");
    expect(pathElement.scrollWidth).toBeGreaterThan(pathElement.clientWidth);
    expect(pathElement.getAttribute("aria-label")).toBe(path);
    expect(title.getAttribute("aria-label")).toBe(label);
    expect(refreshBounds.width).toBeLessThanOrEqual(48);
    expect(refreshBounds.width).toBeGreaterThan(0);
    expect(refreshBounds.right).toBeLessThanOrEqual(headerBounds.right);
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
    expect(pathElement.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(ui.getByLabelText("Read-only review")).toBeTruthy();
    expect(ui.queryByText("Read-only review")).toBeNull();
    expect(ui.queryByText("Live / uncommitted")).toBeNull();
    expect(ui.queryByText("Pin committed review")).toBeNull();
  }
  const count = host.read.mock.calls.length;
  await act(async () => fireEvent.click(ui.getByRole("button", { name: "Refresh" })));
  await waitFor(() => expect(host.read.mock.calls.length).toBeGreaterThan(count));
});
it("never exposes capture controls for main, lab, empty, dirty-only or committed task views", async () => {
  const variants: DevelopmentReviewScope[] = [
    { ...scopes[0], label: "Main source" },
    { ...scopes[0], label: "Lab source" },
    { ...scopes[0], label: "Empty task", sourceWorkspaceId: "retained" },
    { ...scopes[0], label: "Dirty-only task", sourceWorkspaceId: "retained" },
    {
      ...scopes[0],
      label: "Saved task",
      sourceWorkspaceId: "retained",
      evidenceId: "saved",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      status: "committed",
    },
  ];
  for (const scope of variants) {
    cache.clear();
    renderReview(scope, scope.label === "Dirty-only task");
    await waitFor(() =>
      expect(within(container).getByTestId("development-review-title").textContent).toBe(
        scope.label,
      ),
    );
    const ui = within(container);
    expect(ui.getAllByRole("button").length).toBe(1);
    expect(ui.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(
      ui.queryByRole("button", { name: /Pin committed review|Save.*review|커밋 검토 고정/ }),
    ).toBeNull();
    if (scope.evidenceId) {
      expect(ui.getByText("Saved review")).toBeTruthy();
      expect(ui.getByTestId("development-review-empty").textContent).toBe(
        "No changes in this saved review",
      );
    } else if (scope.label === "Dirty-only task")
      expect(ui.getByText("legitimate-image.png")).toBeTruthy();
    else
      expect(ui.getByTestId("development-review-empty").textContent).toBe("No uncommitted changes");
  }
  expect(host.capture).not.toHaveBeenCalled();
});
