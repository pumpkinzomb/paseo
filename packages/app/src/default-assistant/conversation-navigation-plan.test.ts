import { resolveRoomLeads, selectRoomLeadAgentIds, selectLeadWork } from "./room-leads";
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

describe("room lead directory", () => {
  it("keeps independent leads and consolidates native segments in the same room", async () => {
    const first = {
      logicalId: "a",
      activeAgentId: "claude-a",
      activeWorkspaceId: "workspace-a",
      segments: [segment("codex-a"), segment("claude-a")],
    };
    const second = {
      logicalId: "b",
      activeAgentId: "codex-b",
      activeWorkspaceId: "workspace-a",
      segments: [segment("codex-b")],
    };
    const calls: string[] = [];
    const leads = await resolveRoomLeads(
      "workspace-a",
      ["codex-a", "claude-a", "codex-b"],
      async (id) => {
        calls.push(id);
        return id === "codex-b" ? second : first;
      },
    );
    expect(leads).toEqual([first, second]);
    expect(calls).toEqual(["codex-a", "codex-b"]);
  });
  it("excludes archived and foreign-room anchors", async () => {
    const leads = await resolveRoomLeads("workspace-a", ["old", "foreign"], async (id) => ({
      logicalId: id,
      archivedAt: id === "old" ? "2026-11-01" : null,
      activeAgentId: id,
      activeWorkspaceId: "other",
      segments: [segment(id, "other")],
    }));
    expect(leads).toEqual([]);
  });
  it("fails explicitly rather than projecting unresolved segments as leads", async () => {
    await expect(
      resolveRoomLeads("workspace-a", ["segment"], async () => {
        throw new Error("Disconnected");
      }),
    ).rejects.toThrow("Disconnected");
  });
});

describe("room lead ownership", () => {
  it("uses explicit room IDs, never matching directories, and excludes archived/background leads", () => {
    const lead = { id: "a", workspaceId: "room", labels: { "paseo.role": "assistant" } };
    expect(
      selectRoomLeadAgentIds(
        [
          lead,
          { ...lead, id: "other", workspaceId: "other" },
          { ...lead, id: "hidden", background: true },
          { ...lead, id: "old", archivedAt: new Date() },
        ],
        "room",
      ),
    ).toEqual(["a"]);
  });
  it("groups children of every provider segment with exact parent host authority", () => {
    const conversation = {
      logicalId: "a",
      activeAgentId: "segment",
      activeWorkspaceId: "room",
      segments: [segment("root", "room"), segment("segment", "room")],
    };
    const child = (id: string, parent: string, host = "host") => ({
      id,
      labels: { "paseo.parent-agent-id": parent, "paseo.parent-server-id": host },
    });
    const first = child("first", "root");
    const second = child("second", "segment");
    expect(
      selectLeadWork(
        [
          first,
          second,
          child("foreign", "root", "foreign-host"),
          child("unknown", "unknown"),
          child("root", "root"),
          { ...child("hidden", "root"), background: true },
          { ...child("old", "root"), archivedAt: new Date() },
        ],
        "host",
        conversation,
      ),
    ).toEqual([first, second]);
  });
});
