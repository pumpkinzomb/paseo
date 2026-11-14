import type { Agent } from "@/stores/session-store";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AssistantConversation } from "@getpaseo/protocol/messages";
import { planAssistantConversationNavigation } from "./conversation-navigation-plan";

/** Fetch each logical conversation once, even when the directory contains several segments. */
export async function resolveRoomLeads(
  workspaceId: string,
  agentIds: readonly string[],
  load: (agentId: string) => Promise<AssistantConversation>,
): Promise<AssistantConversation[]> {
  const covered = new Set<string>();
  const leads: AssistantConversation[] = [];
  for (const agentId of agentIds) {
    if (covered.has(agentId)) continue;
    const conversation = await load(agentId);
    const plan = planAssistantConversationNavigation(conversation);
    for (const segment of conversation.segments) covered.add(segment.agentId);
    if (plan.workspaceId === workspaceId && !conversation.archivedAt) leads.push(conversation);
  }
  return leads;
}

export function selectRoomLeadAgentIds(
  agents: Iterable<Pick<Agent, "id" | "workspaceId" | "labels" | "archivedAt" | "background">>,
  workspaceId: string,
): string[] {
  return [...agents]
    .filter(
      (agent) =>
        agent.workspaceId === workspaceId &&
        agent.labels["paseo.role"] === "assistant" &&
        !agent.archivedAt &&
        !agent.background,
    )
    .map((agent) => agent.id)
    .sort();
}

export function selectLeadWork<
  T extends Pick<Agent, "id" | "labels" | "archivedAt" | "background">,
>(agents: Iterable<T>, serverId: string, conversation: AssistantConversation): T[] {
  const segments = new Set(conversation.segments.map((segment) => segment.agentId));
  return [...agents].filter((agent) => {
    const parent = getParentAddressFromLabels(agent.labels, serverId);
    return (
      !agent.archivedAt &&
      !agent.background &&
      !segments.has(agent.id) &&
      parent?.serverId === serverId &&
      segments.has(parent.agentId)
    );
  });
}
