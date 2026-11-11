import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSessionDeletePage, sessionsInWorkspace } from "./workspace-session-delete-page";
const mocks = vi.hoisted(() => ({
  agents: [] as ReturnType<typeof agent>[],
  remove: vi.fn(),
  close: vi.fn(),
  loading: false,
}));
vi.mock("@/hooks/use-aggregated-agents", () => ({
  useAggregatedAgents: () => ({
    agents: mocks.agents,
    isInitialLoad: mocks.loading,
  }),
}));
vi.mock("@/hooks/use-delete-session-record", () => ({
  useDeleteSessionRecord:
    (host: string, id: string, close: () => void, workspace: string) => async () => {
      await mocks.remove(host, id, workspace);
      close();
    },
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    testID,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
    disabled: boolean;
    testID: string;
  }) => (
    <button type="button" disabled={disabled} data-testid={testID} onClick={onSelect}>
      {children}
    </button>
  ),
  useDropdownMenuClose: () => mocks.close,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const agent = (id: string, workspaceId = "w", serverId = "s", status = "idle") => ({
  id,
  title: "Same title",
  workspaceId,
  serverId,
  provider: "codex",
  status,
});
beforeEach(() => {
  vi.stubGlobal("React", React);
  mocks.agents = [];
  mocks.loading = false;
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.close.mockReset();
});
afterEach(cleanup);
describe("workspace deletion targets", () => {
  it("limits selection to the exact host/workspace and never picks a target implicitly", () => {
    mocks.agents = [
      agent("a"),
      agent("b"),
      agent("other-workspace", "other"),
      agent("other-host", "w", "other"),
    ];
    render(<WorkspaceSessionDeletePage serverId="s" workspaceId="w" />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Same title · codex · a",
      "Same title · codex · b",
    ]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("selects only the explicit session and preserves workspace scope", async () => {
    mocks.agents = [agent("a"), agent("b")];
    render(<WorkspaceSessionDeletePage serverId="s" workspaceId="w" />);
    fireEvent.click(screen.getByTestId("workspace-session-delete-b"));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("s", "b", "w"));
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("disables busy targets and exposes an empty state", () => {
    mocks.agents = [agent("busy", "w", "s", "running")];
    const view = render(<WorkspaceSessionDeletePage serverId="s" workspaceId="w" />);
    fireEvent.click(screen.getByRole("button"));
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.agents = [];
    view.rerender(<WorkspaceSessionDeletePage serverId="s" workspaceId="w" />);
    expect(screen.getByText("workspaceSessionDeletion.empty").textContent).toBe(
      "workspaceSessionDeletion.empty",
    );
  });
  it("does not include sessions lacking ownership", () => {
    expect(sessionsInWorkspace([{ serverId: "s" }], "s", "w")).toEqual([]);
  });
});
