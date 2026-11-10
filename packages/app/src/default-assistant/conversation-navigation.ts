import type { AssistantConversation } from "@getpaseo/protocol/messages";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { planAssistantConversationNavigation } from "./conversation-navigation-plan";

/** Layout-only consolidation: never archive/delete a provider session or its history. */
export function navigateAssistantConversation({
  serverId,
  conversation,
}: {
  serverId: string;
  conversation: AssistantConversation;
}): string {
  const plan = planAssistantConversationNavigation(conversation);
  if (plan.workspaceId) {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId,
      workspaceId: plan.workspaceId,
    });
    const layout = useWorkspaceLayoutStore.getState();
    const hidden = new Set(plan.hiddenAgentIds);
    const tabs = workspaceKey ? layout.getWorkspaceTabs(workspaceKey) : [];
    if (!workspaceKey)
      return navigateToAgent({
        serverId,
        agentId: plan.agentId,
        workspaceId: plan.workspaceId,
        pin: true,
      });
    for (const agentId of hidden) {
      layout.unpinAgent(workspaceKey, agentId);
      layout.hideAgent(workspaceKey, agentId);
    }
    for (const tab of tabs) {
      if (tab.target.kind === "agent" && hidden.has(tab.target.agentId)) {
        layout.closeTab(workspaceKey, tab.tabId);
      }
    }
    layout.unhideAgent(workspaceKey, plan.agentId);
  }
  return navigateToAgent({
    serverId,
    agentId: plan.agentId,
    workspaceId: plan.workspaceId,
    pin: true,
  });
}
