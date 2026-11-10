import type { AssistantConversation } from "@getpaseo/protocol/messages";

/** A logical conversation must never route controls to an unrelated native session. */
export function validateAssistantConversation(conversation: AssistantConversation | null): void {
  if (!conversation) return;
  const ids = conversation.segments.map((segment) => segment.agentId);
  if (!ids.includes(conversation.activeAgentId) || new Set(ids).size !== ids.length) {
    throw new Error("Assistant conversation segments are inconsistent. Refresh the conversation.");
  }
}

export function previousAssistantSegments(conversation: AssistantConversation | null) {
  return (
    conversation?.segments.filter((segment) => segment.agentId !== conversation.activeAgentId) ?? []
  );
}
