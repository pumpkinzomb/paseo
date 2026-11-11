import { collectAllTabs } from "@/stores/workspace-layout-actions";
import {
  selectIsExplorerSidebarVisible,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useWorkspaceBrowserStore } from "./workspace-store";
import { createWorkspaceBrowser } from "./store";

export function revealWorkspaceBrowser(
  workspaceKey: string,
  options: { respectHidden?: boolean } = {},
): void {
  const layout = useWorkspaceLayoutStore.getState();
  const existing = layout.layoutByWorkspace[workspaceKey];
  if (
    options.respectHidden &&
    existing &&
    collectAllTabs(existing.root).some((tab) => tab.target.kind === "browser_workspace") &&
    !selectIsExplorerSidebarVisible(layout, workspaceKey)
  ) {
    return;
  }
  const paneId = layout.ensureExplorerSidebar(workspaceKey);
  if (!paneId) return;
  const tabId = layout.openTab({
    workspaceKey,
    target: { kind: "browser_workspace" },
    intent: "background",
    placement: { mode: "pane", paneId },
  });
  layout.showExplorerSidebar(workspaceKey);
  if (tabId) layout.selectTabInPane(workspaceKey, paneId, tabId, { requestFocus: false });
}
export function openWorkspaceBrowserPage(workspaceKey: string, initialUrl?: string): string {
  const { browserId } = createWorkspaceBrowser({ initialUrl });
  const layout = useWorkspaceLayoutStore.getState();
  if (layout.layoutMode !== "split-panes") {
    layout.openTab({ workspaceKey, target: { kind: "browser", browserId }, intent: "reveal" });
    return browserId;
  }
  useWorkspaceBrowserStore.getState().openPage(workspaceKey, browserId);
  revealWorkspaceBrowser(workspaceKey);
  return browserId;
}
