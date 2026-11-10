import type { AssistantConversation } from "@getpaseo/protocol/messages";

/** Preserve the original workspace/tab identity; native providers are implementation segments. */
export function planAssistantConversationNavigation(conversation: AssistantConversation) {
  const anchor = conversation.segments[0];
  if (
    !anchor ||
    !conversation.segments.some((segment) => segment.agentId === conversation.activeAgentId)
  ) {
    throw new Error("Assistant conversation has no valid active segment.");
  }
  return {
    agentId: anchor.agentId,
    workspaceId: anchor.workspaceId,
    hiddenAgentIds: conversation.segments
      .filter(
        (segment) =>
          segment.agentId !== anchor.agentId && segment.workspaceId === anchor.workspaceId,
      )
      .map((segment) => segment.agentId),
  };
}
