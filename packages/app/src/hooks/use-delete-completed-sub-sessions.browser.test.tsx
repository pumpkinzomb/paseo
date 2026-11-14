import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDeleteCompletedSubSessions } from "./use-delete-completed-sub-sessions";
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
  mocks.preview.mockImplementation(async (id: string) => ({
    agentIds: [id],
    workspaceIds: [id],
    error: null,
  }));
  mocks.remove.mockImplementation(async (id: string) => ({
    agentIds: [id],
    workspaceIds: [id],
    error: null,
  }));
  mocks.confirm.mockResolvedValue(false);
  mocks.refresh.mockResolvedValue(undefined);
});
afterEach(cleanup);
function Harness({
  workspaceId = "workspace",
  strict = false,
  scoped = false,
}: {
  workspaceId?: string;
  strict?: boolean;
  scoped?: boolean;
}) {
  const { remove, pending } = useDeleteCompletedSubSessions(
    "host",
    workspaceId,
    ["child-a", "child-b", "child-a"],
    mocks.close,
    {
      restrictToTargets: strict,
      ownerKey: strict ? "lead-a" : undefined,
      ...(scoped ? { leadAssociations: { "child-a": undefined, "child-b": undefined } } : {}),
    },
  );
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
it("previews all unique completed children and cancels without deletion", async () => {
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
  expect(mocks.preview.mock.calls).toEqual([["child-a"], ["child-b"]]);
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("one confirmation removes the frozen groups and refreshes once", async () => {
  mocks.confirm.mockResolvedValue(true);
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.remove.mock.calls).toEqual([
    ["child-a", ["child-a"], ["child-a"]],
    ["child-b", ["child-b"], ["child-b"]],
  ]);
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledWith(["child-a", "child-b"]);
});
it("refuses a scope containing the parent before confirmation", async () => {
  mocks.preview.mockResolvedValue({
    agentIds: ["parent"],
    workspaceIds: ["child-a", "workspace"],
    error: null,
  });
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it("stops on uncertain deletion, does not retry or continue", async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.remove.mockRejectedValue(new Error("offline"));
  show();
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  expect(mocks.remove).toHaveBeenCalledTimes(1);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.toast.error.mock.calls[0][0]).toContain("uncertain");
});

it("refuses a lead batch if any preview reaches a sibling or unassigned workspace", async () => {
  mocks.preview.mockResolvedValue({
    agentIds: ["a", "b"],
    workspaceIds: ["child-a", "foreign-lead-work"],
    error: null,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness strict />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});

it("freezes exact room/owner revisions for each lead-owned completed target", async () => {
  mocks.preview.mockImplementation(async (id: string) => ({
    agentIds: [id],
    workspaceIds: [id],
    workspaceRevision: `revision-${id}`,
    error: null,
  }));
  mocks.confirm.mockResolvedValue(true);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness strict scoped />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
  for (const id of ["child-a", "child-b"]) {
    const scope = { roomWorkspaceId: "workspace", leadAssociation: undefined, itemKind: "session" };
    expect(mocks.preview).toHaveBeenCalledWith(id, scope);
    expect(mocks.remove).toHaveBeenCalledWith(id, [id], [id], false, {
      scope,
      revision: `revision-${id}`,
    });
  }
});
