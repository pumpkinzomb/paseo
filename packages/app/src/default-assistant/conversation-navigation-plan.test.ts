import { describe, expect, it } from "vitest";
import { planAssistantConversationNavigation } from "./conversation-navigation-plan";
const segment = (agentId: string, workspaceId = "workspace-a") => ({
  agentId,
  workspaceId,
  provider: "codex",
  model: "model",
  createdAt: "2026-11-10T00:00:00Z",
});
describe("logical assistant navigation", () => {
  it("keeps the first segment as the stable tab after provider switches", () => {
    expect(
      planAssistantConversationNavigation({
        logicalId: "logical-a",
        activeAgentId: "claude-b",
        activeWorkspaceId: "workspace-a",
        segments: [segment("codex-a"), segment("claude-b")],
      }),
    ).toEqual({ agentId: "codex-a", workspaceId: "workspace-a", hiddenAgentIds: ["claude-b"] });
  });
  it("does not hide migrated segments in a different workspace", () => {
    expect(
      planAssistantConversationNavigation({
        logicalId: "logical-a",
        activeAgentId: "claude-b",
        activeWorkspaceId: "workspace-b",
        segments: [segment("codex-a"), segment("claude-b", "workspace-b")],
      }).hiddenAgentIds,
    ).toEqual([]);
  });
  it("rejects incomplete metadata rather than navigating to the wrong session", () => {
    expect(() =>
      planAssistantConversationNavigation({
        logicalId: "x",
        activeAgentId: "missing",
        activeWorkspaceId: null,
        segments: [segment("root")],
      }),
    ).toThrow("active segment");
  });
});
