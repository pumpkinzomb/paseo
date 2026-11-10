import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/** Capture workspace ownership before removing records from the runtime store. */
export function collectSessionWorkspaces(serverId: string): Map<string, string> {
  const session = useSessionStore.getState().sessions[serverId];
  const workspaces = new Map<string, string>();
  for (const agent of session?.agentDetails.values() ?? []) {
    if (agent.workspaceId) workspaces.set(agent.id, agent.workspaceId);
  }
  for (const agent of session?.agents.values() ?? []) {
    if (agent.workspaceId) workspaces.set(agent.id, agent.workspaceId);
  }
  return workspaces;
}

/** Only remove local tab references, never archive or delete additional records. */
export function closeSessionTabs(
  serverId: string,
  agentIds: readonly string[],
  workspaces: ReadonlyMap<string, string>,
): void {
  const layout = useWorkspaceLayoutStore.getState();
  for (const id of agentIds) {
    const workspaceId = workspaces.get(id);
    if (!workspaceId) continue;
    const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
    if (!key) continue;
    layout.unpinAgent(key, id);
    layout.hideAgent(key, id);
    for (const tab of layout.getWorkspaceTabs(key)) {
      if (tab.target.kind === "agent" && tab.target.agentId === id) {
        layout.closeTab(key, tab.tabId);
      }
    }
  }
}
