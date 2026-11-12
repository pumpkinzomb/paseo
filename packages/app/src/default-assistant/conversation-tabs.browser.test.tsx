import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useConsolidateAssistantConversationTabs } from "./conversation-tabs";
const mocks = vi.hoisted(() => ({ active: true, workspaceId: "workspace", navigated: vi.fn() }));
vi.mock("@/components/retained-panel", () => ({ useRetainedPanelActive: () => mocks.active }));
vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: (input: { serverId: string; workspaceId: string; agentId: string }) => {
    mocks.navigated(input);
    return useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: `${input.serverId}:${input.workspaceId}`,
      target: { kind: "agent", agentId: input.agentId },
      intent: "reveal",
    });
  },
}));
const key = "host:workspace";
const conversation = {
  logicalId: "logical",
  activeAgentId: "codex",
  activeWorkspaceId: "workspace",
  segments: ["claude", "codex"].map((agentId) => ({
    agentId,
    workspaceId: "workspace",
    provider: "codex",
    model: "model",
    createdAt: "2026-11-12T00:00:00Z",
  })),
};
function Harness() {
  useConsolidateAssistantConversationTabs("host", conversation, mocks.workspaceId);
  return <div>conversation</div>;
}
function open(agentId: string) {
  useWorkspaceLayoutStore
    .getState()
    .openTab({ workspaceKey: key, target: { kind: "agent", agentId }, intent: "reveal" });
}
function ids() {
  return useWorkspaceLayoutStore
    .getState()
    .getWorkspaceTabs(key)
    .flatMap((t) => (t.target.kind === "agent" ? [t.target.agentId] : []));
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  mocks.active = true;
  mocks.workspaceId = "workspace";
  mocks.navigated.mockClear();
  useWorkspaceLayoutStore.setState(useWorkspaceLayoutStore.getInitialState(), true);
});
afterEach(cleanup);
describe("logical conversation restored tabs", () => {
  it("consolidates actual restored provider tabs without native session actions", async () => {
    open("codex");
    open("claude");
    open("unrelated");
    render(<Harness />);
    await waitFor(() => expect(ids()).toEqual(expect.arrayContaining(["claude", "unrelated"])));
    expect(ids()).not.toContain("codex");
    expect(mocks.navigated).toHaveBeenCalledTimes(1);
  });
  it("repairs repeated direct segment openings without looping", async () => {
    open("codex");
    render(<Harness />);
    await waitFor(() => expect(ids()).toEqual(["claude"]));
    act(() => open("codex"));
    await waitFor(() => expect(ids()).toEqual(["claude"]));
    expect(mocks.navigated).toHaveBeenCalledTimes(2);
  });
  it("does not redirect a retained inactive conversation", () => {
    open("codex");
    open("claude");
    mocks.active = false;
    render(<Harness />);
    expect(ids()).toHaveLength(2);
    expect(mocks.navigated).not.toHaveBeenCalled();
  });
  it("does not navigate away from another workspace", () => {
    open("codex");
    open("claude");
    mocks.workspaceId = "other-workspace";
    render(<Harness />);
    expect(ids()).toHaveLength(2);
    expect(mocks.navigated).not.toHaveBeenCalled();
  });
  it("leaves an already consolidated layout unchanged", () => {
    open("claude");
    render(<Harness />);
    expect(ids()).toEqual(["claude"]);
    expect(mocks.navigated).not.toHaveBeenCalled();
  });
});
