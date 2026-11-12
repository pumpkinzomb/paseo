import { useEffect } from "react";
import type { AssistantConversation } from "@getpaseo/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { navigateAssistantConversation } from "./conversation-navigation";
import { hasAssistantConversationAliasTab } from "./conversation-navigation-plan";

/** Repair restored/opened provider tabs without deleting native sessions or history. */
export function useConsolidateAssistantConversationTabs(
  serverId: string,
  conversation: AssistantConversation | null,
  visibleWorkspaceId: string,
  isInteractive: boolean,
) {
  const active = useRetainedPanelActive();
  const anchorWorkspaceId = conversation?.segments[0]?.workspaceId;
  const workspaceKey = anchorWorkspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId: anchorWorkspaceId })
    : null;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  useEffect(() => {
    if (
      !active ||
      !isInteractive ||
      !conversation ||
      !workspaceKey ||
      visibleWorkspaceId !== anchorWorkspaceId
    )
      return;
    const tabs = useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey);
    const agentIds = tabs.flatMap((tab) =>
      tab.target.kind === "agent" ? [tab.target.agentId] : [],
    );
    if (hasAssistantConversationAliasTab(conversation, agentIds)) {
      navigateAssistantConversation({ serverId, conversation });
    }
  }, [
    active,
    isInteractive,
    anchorWorkspaceId,
    conversation,
    layout,
    serverId,
    visibleWorkspaceId,
    workspaceKey,
  ]);
}
