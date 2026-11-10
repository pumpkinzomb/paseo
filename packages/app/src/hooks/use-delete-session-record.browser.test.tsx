import React, { useCallback } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeleteSessionRecord } from "./use-delete-session-record";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  deleteRecord: vi.fn(),
  deleteConversation: vi.fn(),
  confirm: vi.fn(),
  refresh: vi.fn(),
  toast: { show: vi.fn(), error: vi.fn() },
  supported: true,
  manager: false,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    fetchAgent: mocks.fetch,
    deleteAgentRecord: mocks.deleteRecord,
    mutateAssistantConversation: mocks.deleteConversation,
  }),
  getHostRuntimeStore: () => ({ refreshDirectories: mocks.refresh }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => mocks.supported }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => mocks.toast }));
vi.mock("@/default-assistant/conversation", () => ({
  ASSISTANT_CONVERSATION_QUERY_ROOT: "testConversation",
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(() => mocks.manager, { getState: () => ({ sessions: {} }) }),
}));
vi.mock("@/stores/workspace-layout-store", () => ({
  useWorkspaceLayoutStore: { getState: () => ({}) },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => {
  vi.stubGlobal("React", React);
  mocks.supported = true;
  mocks.manager = false;
  mocks.fetch.mockReset().mockImplementation(async () => ({
    agent: { id: "test", labels: mocks.manager ? { "paseo.role": "assistant" } : {} },
  }));
  mocks.deleteRecord.mockReset().mockResolvedValue({ agentIds: ["test"], error: null });
  mocks.deleteConversation.mockReset().mockResolvedValue({ agentIds: ["test"], error: null });
  mocks.confirm.mockReset().mockResolvedValue(false);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.toast.show.mockReset();
  mocks.toast.error.mockReset();
});
afterEach(cleanup);
function Harness() {
  const remove = useDeleteSessionRecord("fake", "test");
  const handleClick = useCallback(() => {
    void remove?.();
  }, [remove]);
  return (
    <button type="button" disabled={!remove} onClick={handleClick}>
      Delete
    </button>
  );
}
function show() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
}
describe("session delete routing (no real backend)", () => {
  it("cancel preserves an ordinary session", async () => {
    show();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.confirm.mock.calls[0][0].message).toBe("sessionRecordDeletion.confirm");
    expect(mocks.deleteRecord).not.toHaveBeenCalled();
    expect(mocks.deleteConversation).not.toHaveBeenCalled();
  });
  it("confirmed ordinary deletion calls only the single-record API", async () => {
    mocks.confirm.mockResolvedValue(true);
    show();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.deleteRecord).toHaveBeenCalledExactlyOnceWith("test"));
    expect(mocks.deleteConversation).not.toHaveBeenCalled();
  });
  it("manager tabs use whole-conversation confirmation and API", async () => {
    mocks.manager = true;
    mocks.confirm.mockResolvedValue(true);
    show();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(mocks.deleteConversation).toHaveBeenCalledExactlyOnceWith("test", "delete"),
    );
    expect(mocks.confirm.mock.calls[0][0].message).toBe("assistantLifecycle.deleteConfirm");
    expect(mocks.deleteRecord).not.toHaveBeenCalled();
  });
  it("server rejection is shown and never retried", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.deleteRecord.mockRejectedValue(new Error("Working child"));
    show();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Working child"));
    expect(mocks.deleteRecord).toHaveBeenCalledTimes(1);
  });
  it("does not offer deletion on an older server", () => {
    mocks.supported = false;
    show();
    fireEvent.click(screen.getByRole("button"));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
