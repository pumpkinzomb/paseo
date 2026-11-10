import { describe, expect, it } from "vitest";
import type { AssistantConversation } from "@getpaseo/protocol/messages";
import { previousAssistantSegments, validateAssistantConversation } from "./conversation-model";
const conversation: AssistantConversation = {
  logicalId: "logical",
  activeAgentId: "new",
  activeWorkspaceId: "workspace",
  segments: [
    {
      agentId: "old",
      workspaceId: "workspace",
      provider: "codex",
      model: "original",
      createdAt: "1",
    },
    {
      agentId: "middle",
      workspaceId: "workspace",
      provider: "claude",
      model: "middle",
      createdAt: "2",
    },
    {
      agentId: "new",
      workspaceId: "workspace",
      provider: "codex",
      model: "latest",
      createdAt: "3",
    },
  ],
};
describe("logical assistant segments", () => {
  it("keeps past segments in order and excludes the sole active input target", () => {
    expect(previousAssistantSegments(conversation).map((segment) => segment.agentId)).toEqual([
      "old",
      "middle",
    ]);
    expect(() => validateAssistantConversation(conversation)).not.toThrow();
    expect(conversation.activeAgentId).toBe("new");
  });
  it("rejects an unrelated active agent or duplicate segments", () => {
    expect(() =>
      validateAssistantConversation({ ...conversation, activeAgentId: "unrelated" }),
    ).toThrow("inconsistent");
    expect(() =>
      validateAssistantConversation({
        ...conversation,
        segments: [...conversation.segments, conversation.segments[0]!],
      }),
    ).toThrow("inconsistent");
  });
  it("leaves non-manager conversations alone", () => {
    expect(previousAssistantSegments(null)).toEqual([]);
    expect(() => validateAssistantConversation(null)).not.toThrow();
  });
});
