import { AssistantLifecycleControls } from "./lifecycle-controls";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  confirm: vi.fn(),
  refresh: vi.fn(),
  supported: true,
  agents: new Map<string, { id: string; workspaceId: string }>(),
  closeTab: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ mutateAssistantConversation: mocks.mutate }),
  getHostRuntimeStore: () => ({ refreshDirectories: mocks.refresh }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => mocks.supported }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("./conversation", () => ({
  ASSISTANT_CONVERSATION_QUERY_ROOT: "testConversation",
  useAssistantConversationContext: () => null,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(() => undefined, {
    getState: () => ({ sessions: { fake: { agents: mocks.agents, agentDetails: new Map() } } }),
  }),
}));
vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: {
    getState: () => ({
      unpinAgent: vi.fn(),
      hideAgent: vi.fn(),
      closeTab: mocks.closeTab,
      getWorkspaceTabs: () => [{ tabId: "tab", target: { kind: "agent", agentId: "test-only" } }],
    }),
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  vi.stubGlobal("React", React);
  mocks.supported = true;
  mocks.agents.clear();
  mocks.closeTab.mockReset();
  mocks.mutate
    .mockReset()
    .mockResolvedValue({ agentIds: ["test-only"], action: "delete", error: null });
  mocks.confirm.mockReset().mockResolvedValue(false);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
function show(props: { archived?: boolean; status?: string } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AssistantLifecycleControls
        serverId="fake"
        agentId="test-only"
        archived={props.archived ?? false}
        status={props.status ?? "idle"}
      />
    </QueryClientProvider>,
  );
}
describe("assistant lifecycle controls (isolated fake client)", () => {
  it("cancelling permanent deletion never calls the server", async () => {
    show();
    fireEvent.click(screen.getByText("assistantLifecycle.delete"));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0][0].destructive).toBe(true);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("offers restore for archived conversations and restores only after confirmation", async () => {
    mocks.confirm.mockResolvedValue(true);
    show({ archived: true });
    expect(screen.queryByText("assistantLifecycle.archive")).toBeNull();
    fireEvent.click(screen.getByText("assistantLifecycle.restore"));
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith("test-only", "restore"),
    );
  });
  it("shows server rejection without silently closing or retrying", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.mutate.mockRejectedValue(new Error("A child is running"));
    show();
    fireEvent.click(screen.getByText("assistantLifecycle.archive"));
    await waitFor(() => expect(screen.getByText("A child is running")).toBeTruthy());
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
  it("blocks active work and unsupported hosts", () => {
    show({ status: "running" });
    fireEvent.click(screen.getByText("assistantLifecycle.delete"));
    expect(mocks.confirm).not.toHaveBeenCalled();
    cleanup();
    mocks.supported = false;
    show();
    expect(screen.queryByText("assistantLifecycle.delete")).toBeNull();
    expect(screen.getByText("defaultAssistant.updateHost")).toBeTruthy();
  });
  it("cleans tabs even if a removal event already removed the agent snapshot", async () => {
    mocks.agents.set("test-only", { id: "test-only", workspaceId: "workspace" });
    mocks.confirm.mockResolvedValue(true);
    mocks.mutate.mockImplementation(async () => {
      mocks.agents.clear();
      return { agentIds: ["test-only"], error: null };
    });
    show();
    fireEvent.click(screen.getByText("assistantLifecycle.delete"));
    await waitFor(() => expect(mocks.closeTab).toHaveBeenCalledTimes(1));
  });
  it("reports refresh failure as completed rather than retrying the mutation", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.refresh.mockRejectedValue(new Error("refresh offline"));
    show();
    fireEvent.click(screen.getByText("assistantLifecycle.delete"));
    await waitFor(() =>
      expect(screen.getByText("assistantLifecycle.completedRefreshFailed")).toBeTruthy(),
    );
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});
