import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { setPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { openFileInExplorer } from "./open-file-in-explorer";
const key = "server-1:workspace-1";
const location = { path: "/work/.paseo-document-previews/" + "a".repeat(64) + ".md" };
let modified: string | null = null;
beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
  });
  useWorkspaceLayoutStore
    .getState()
    .openTab({ workspaceKey: key, target: { kind: "agent", agentId: "lead" }, intent: "reveal" });
});
afterEach(() => {
  if (modified)
    setPanelInstanceAttributes(
      { serverId: "server-1", workspaceId: "workspace-1", tabId: modified },
      { modified: false },
    );
  modified = null;
});
function open() {
  return openFileInExplorer({ workspaceKey: key, location, isCompact: false });
}
function withBrowser() {
  const store = useWorkspaceLayoutStore.getState();
  const id = store.showExplorerSidebar(key);
  if (!id) throw new Error("Expected Explorer");
  const browser = store.openTab({
    workspaceKey: key,
    target: { kind: "browser_workspace" },
    intent: "reveal",
    placement: { mode: "pane", paneId: id },
  });
  return { id, browser };
}
function layout() {
  return useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
}
function sideDocument() {
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.ensureSidePane(key);
  if (!paneId) throw new Error("Expected side pane");
  const tabId = store.openTab({
    workspaceKey: key,
    target: { kind: "file", ...location },
    intent: "reveal",
    placement: { mode: "pane", paneId },
  });
  if (!tabId) throw new Error("Expected file tab");
  return { paneId, tabId };
}
describe("document cards in the existing file sidebar", () => {
  it("reuses Explorer beside chat without creating a third pane or replacing Browser", () => {
    const browser = withBrowser();
    const before = collectAllPanes(layout().root).length;
    const result = open();
    expect(result.kind).toBe("opened");
    if (result.kind !== "opened" || !result.tabId) throw new Error("Expected file");
    expect(findPaneContainingTab(layout().root, result.tabId)?.id).toBe(browser.id);
    expect(collectAllPanes(layout().root)).toHaveLength(before);
    expect(collectAllTabs(layout().root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tabId: browser.browser,
          target: { kind: "browser_workspace" },
        }),
      ]),
    );
    expect(findPaneById(layout().root, "main")?.tabIds).toHaveLength(1);
  });
  it("deduplicates repeated opens", () => {
    expect(open()).toEqual(open());
    expect(collectAllTabs(layout().root).filter((tab) => tab.target.kind === "file")).toHaveLength(
      1,
    );
    expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[key]).toBeUndefined();
  });
  it("moves the old file tab into Explorer and removes its now-empty extra split", () => {
    const browser = withBrowser();
    const old = sideDocument();
    expect(open()).toEqual({ kind: "opened", tabId: old.tabId });
    expect(findPaneContainingTab(layout().root, old.tabId)?.id).toBe(browser.id);
    expect(findPaneById(layout().root, old.paneId)).toBeNull();
    expect(collectAllPanes(layout().root).filter((pane) => !pane.hidden)).toHaveLength(2);
  });
  it("keeps a split that still contains unrelated content", () => {
    withBrowser();
    const old = sideDocument();
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: key,
      target: { kind: "terminal", terminalId: "keep" },
      intent: "reveal",
      placement: { mode: "pane", paneId: old.paneId },
    });
    open();
    expect(findPaneById(layout().root, old.paneId)?.tabIds).toHaveLength(1);
  });
  it("does not remount or move an editor with unsaved work", () => {
    withBrowser();
    const old = sideDocument();
    modified = old.tabId;
    setPanelInstanceAttributes(
      { serverId: "server-1", workspaceId: "workspace-1", tabId: old.tabId },
      { modified: true },
    );
    const before = layout();
    expect(open()).toEqual({ kind: "modified", tabId: old.tabId });
    expect(layout()).toBe(before);
  });
  it("uses the native compact sheet without allocating a split", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("compact");
    const before = layout();
    const result = openFileInExplorer({ workspaceKey: key, location, isCompact: true });
    expect(result.kind).toBe("opened");
    expect(layout()).toBe(before);
    expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[key]?.at(-1)?.tab.target).toEqual({
      kind: "file",
      ...location,
    });
  });
  it("does not require desktop split support", () => {
    useWorkspaceLayoutStore.getState().setLayoutMode("single-pane");
    const result = open();
    if (result.kind !== "opened" || !result.tabId) throw new Error("Expected file");
    expect(useWorkspaceLayoutStore.getState().getTabDestination(key, result.tabId)?.kind).toBe(
      "pane",
    );
    expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[key]).toBeUndefined();
  });
  it("does nothing without a workspace", () => {
    const before = layout();
    expect(openFileInExplorer({ workspaceKey: null, location, isCompact: false })).toEqual({
      kind: "opened",
      tabId: null,
    });
    expect(layout()).toBe(before);
  });
});
