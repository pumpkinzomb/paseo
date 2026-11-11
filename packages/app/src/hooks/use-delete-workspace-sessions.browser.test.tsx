import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDeleteWorkspaceSessions } from "./use-delete-workspace-sessions";
const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
  closeTabs: vi.fn(),
  collectWorkspaces: vi.fn(() => new Map<string, string>()),
  close: vi.fn(),
  refresh: vi.fn(),
  supported: true,
  toast: { show: vi.fn(), error: vi.fn() },
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => null,
}));
vi.mock("@/utils/sidebar-workspace-archive-redirect", () => ({
  redirectIfArchivingActiveWorkspace: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    inspectWorkspaceSessionDeletion: mocks.preview,
    deleteWorkspaceSessions: mocks.remove,
  }),
  getHostRuntimeStore: () => ({ refreshDirectories: mocks.refresh }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => mocks.supported }));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => mocks.toast }));
vi.mock("@/default-assistant/conversation", () => ({
  ASSISTANT_CONVERSATION_QUERY_ROOT: "testConversation",
}));
vi.mock("@/default-assistant/lifecycle-layout", () => ({
  closeSessionTabs: mocks.closeTabs,
  collectSessionWorkspaces: mocks.collectWorkspaces,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, args?: { count: number }) => (args ? `${key}:${args.count}` : key),
  }),
}));
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
  mocks.supported = true;
  mocks.collectWorkspaces.mockReturnValue(new Map());
  mocks.preview.mockResolvedValue({ agentIds: ["parent", "segment", "child"], error: null });
  mocks.remove.mockResolvedValue({ agentIds: ["parent", "segment", "child"], error: null });
  mocks.confirm.mockResolvedValue(false);
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(cleanup);
function Harness({ workspaceId = "workspace" }: { workspaceId?: string }) {
  const { remove, pending } = useDeleteWorkspaceSessions("host", workspaceId, mocks.close);
  return (
    <button type="button" disabled={!remove || pending} onClick={remove}>
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
it("Cancel leaves the entire group intact", async () => {
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("one confirmation deletes the full authoritative group with no session picker", async () => {
  mocks.confirm.mockResolvedValue(true);
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() =>
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(
      "workspace",
      ["parent", "segment", "child"],
      undefined,
    ),
  );
  expect(mocks.confirm.mock.calls[0][0].message).toBe("workspaceSessionDeletion.confirm:3");
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
it("repeated clicks cannot send duplicate deletion requests", async () => {
  mocks.confirm.mockResolvedValue(true);
  show();
  const button = screen.getByRole("button");
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it("running work blocks the entire group before confirmation", async () => {
  mocks.preview.mockResolvedValue({
    agentIds: [],
    error: "Conversation has running work or pending approval.",
  });
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith("workspaceSessionDeletion.busy"),
  );
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("unmount while previewing prevents an obsolete confirmation or deletion", async () => {
  let resolve!: (value: unknown) => void;
  mocks.preview.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = show();
  fireEvent.click(screen.getByRole("button"));
  view.unmount();
  resolve({ agentIds: ["a"], error: null });
  await Promise.resolve();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("a changed group is never retried automatically", async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.remove.mockResolvedValue({ agentIds: [], error: "Group changed" });
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Group changed"));
  expect(mocks.remove).toHaveBeenCalledTimes(1);
  expect(mocks.close).not.toHaveBeenCalled();
});
it("unsupported hosts cannot silently fall back to per-session deletion", () => {
  mocks.supported = false;
  show();
  fireEvent.click(screen.getByRole("button"));
  expect(mocks.preview).not.toHaveBeenCalled();
});

it("refreshes and reports partial completion without retrying", async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.remove.mockResolvedValue({
    agentIds: ["parent"],
    error: "Deletion was partially completed. Disk failed",
  });
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith("workspaceSessionDeletion.partial"),
  );
  expect(mocks.refresh).toHaveBeenCalled();
  expect(mocks.closeTabs).toHaveBeenCalledWith(
    "host",
    ["parent"],
    new Map([["parent", "workspace"]]),
  );
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it("a lost deletion response is uncertain, not safe to repeat", async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.remove.mockRejectedValue(new Error("Disconnected"));
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith("workspaceSessionDeletion.uncertain"),
  );
  expect(mocks.refresh).toHaveBeenCalled();
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it("changing the target while confirming cancels the old scope", async () => {
  let resolve!: (value: boolean) => void;
  mocks.confirm.mockImplementation(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  const client = new QueryClient();
  const tree = (workspaceId: string) => (
    <QueryClientProvider client={client}>
      <Harness workspaceId={workspaceId} />
    </QueryClientProvider>
  );
  const view = render(tree("workspace"));
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  view.rerender(tree("other"));
  resolve(true);
  await Promise.resolve();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it("sends the confirmed descendant workspace scope and closes child tabs in their own workspace", async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.preview.mockResolvedValue({
    agentIds: ["parent", "child"],
    workspaceIds: ["workspace", "child-workspace"],
    error: null,
  });
  mocks.remove.mockResolvedValue({ agentIds: ["parent", "child"], error: null });
  mocks.collectWorkspaces.mockReturnValue(
    new Map([
      ["parent", "workspace"],
      ["child", "child-workspace"],
    ]),
  );
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() =>
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(
      "workspace",
      ["parent", "child"],
      ["workspace", "child-workspace"],
    ),
  );
  expect(mocks.closeTabs).toHaveBeenCalledWith(
    "host",
    ["parent", "child"],
    new Map([
      ["parent", "workspace"],
      ["child", "child-workspace"],
    ]),
  );
});
