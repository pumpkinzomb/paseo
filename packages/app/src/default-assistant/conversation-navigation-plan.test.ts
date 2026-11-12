import { describe, expect, it } from "vitest";
import {
  hasAssistantConversationAliasTab,
  planAssistantConversationNavigation,
} from "./conversation-navigation-plan";
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

describe("restored assistant segment tabs", () => {
  const conversation = {
    logicalId: "logical-a",
    activeAgentId: "codex-b",
    activeWorkspaceId: "workspace-a",
    segments: [segment("claude-a"), segment("codex-b")],
  };
  it("consolidates two provider tabs for one logical conversation", () => {
    expect(hasAssistantConversationAliasTab(conversation, ["claude-a", "codex-b"])).toBe(true);
  });
  it("also repairs a restored active-segment-only tab", () => {
    expect(hasAssistantConversationAliasTab(conversation, ["codex-b"])).toBe(true);
  });
  it("is idempotent after keeping the anchor", () => {
    expect(hasAssistantConversationAliasTab(conversation, ["claude-a"])).toBe(false);
  });
  it("does not consolidate unrelated or migrated tabs", () => {
    expect(hasAssistantConversationAliasTab(conversation, ["other"])).toBe(false);
    expect(
      hasAssistantConversationAliasTab(
        {
          ...conversation,
          activeWorkspaceId: "workspace-b",
          segments: [segment("claude-a"), segment("codex-b", "workspace-b")],
        },
        ["codex-b"],
      ),
    ).toBe(false);
  });
});
