import { getWorkspacePanelAttributes } from "@/panels/panel-instance-attributes";
import {
  collectAllTabs,
  DEFAULT_PANE_ID,
  findPaneById,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { createWorkspaceFileTabTarget, type WorkspaceFileLocation } from "@/workspace/file-open";
import { showExplorerSidebar } from "./explorer-sidebar";
import { workspaceTabTargetsEqual } from "./identity";
import { revealWorkspaceTab } from "./navigation";

interface OpenFileInExplorerInput {
  workspaceKey: string | null;
  isCompact: boolean;
  location: WorkspaceFileLocation;
  parentTabId?: string | null;
}
export type OpenFileInExplorerResult =
  | { kind: "opened"; tabId: string | null }
  | { kind: "modified"; tabId: string };

/** File cards share Explorer with Files, Changes and Browser; they never allocate a split. */
export function openFileInExplorer(input: OpenFileInExplorerInput): OpenFileInExplorerResult {
  if (!input.workspaceKey) return { kind: "opened", tabId: null };
  const workspaceKey = input.workspaceKey;
  const store = useWorkspaceLayoutStore.getState();
  const target = createWorkspaceFileTabTarget(input.location);
  const layout = store.layoutByWorkspace[workspaceKey];
  const existing =
    layout &&
    collectAllTabs(layout.root).find((tab) => workspaceTabTargetsEqual(tab.target, target));
  const source = existing && findPaneContainingTab(layout.root, existing.tabId);
  const explorerId = store.explorerSidebarPaneIdByWorkspace[workspaceKey];
  const crossingHosts = !input.isCompact && source && source.id !== explorerId;
  if (
    existing &&
    crossingHosts &&
    getWorkspacePanelAttributes(workspaceKey, existing.tabId).modified
  ) {
    return { kind: "modified", tabId: existing.tabId };
  }
  if (input.isCompact) {
    return {
      kind: "opened",
      tabId: store.openTab({
        workspaceKey,
        target,
        intent: "reveal",
        parentTabId: input.parentTabId ?? undefined,
      }),
    };
  }
  const paneId = showExplorerSidebar(input);
  if (!paneId) return { kind: "opened", tabId: null };
  if (existing && source && source.id !== paneId) {
    store.moveTabToPane(workspaceKey, existing.tabId, paneId);
    // A document opened by the old side-pane route may be its only content.
    const next = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const emptied = findPaneById(next.root, source.id);
    const remaining = collectAllTabs(next.root).filter((tab) =>
      emptied?.tabIds.includes(tab.tabId),
    );
    const disposable =
      emptied &&
      emptied.id !== DEFAULT_PANE_ID &&
      remaining.every((tab) => tab.target.kind === "new_tab");
    if (disposable) store.closePane(workspaceKey, source.id);
    return { kind: "opened", tabId: revealWorkspaceTab(workspaceKey, existing.tabId) };
  }
  const tabId = store.openTab({
    workspaceKey,
    target,
    intent: "reveal",
    placement: { mode: "prefer", paneId },
    parentTabId: input.parentTabId ?? undefined,
  });
  return { kind: "opened", tabId: revealWorkspaceTab(workspaceKey, tabId) };
}
