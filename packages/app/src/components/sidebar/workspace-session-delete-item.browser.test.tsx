import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceSessionDeleteItem } from "./workspace-session-delete-item";
const mocks = vi.hoisted(() => ({ remove: vi.fn(), pending: false, close: vi.fn() }));
vi.mock("@/hooks/use-delete-workspace-sessions", () => ({
  useDeleteWorkspaceSessions: () => mocks,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "삭제" }) }));
vi.mock("lucide-react-native", () => ({ Trash2: () => <span data-testid="trash-icon" /> }));
vi.mock("react-native-unistyles", () => ({ withUnistyles: (component: unknown) => component }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  useDropdownMenuClose: () => mocks.close,
  DropdownMenuItem: ({
    children,
    leading,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    leading: React.ReactNode;
    onSelect: () => void;
    disabled: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {leading}
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/context-menu", async () => ({
  ContextMenuItem: (await import("@/components/ui/dropdown-menu")).DropdownMenuItem,
}));
beforeEach(() => {
  vi.stubGlobal("React", React);
  mocks.pending = false;
  mocks.remove.mockReset();
});
afterEach(cleanup);
it.each(["dropdown", "context"] as const)(
  "%s uses one trash Delete action rather than a session selector",
  (surface) => {
    render(
      <WorkspaceSessionDeleteItem
        serverId="host"
        workspaceId="w"
        workspaceKey="key"
        surface={surface}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("trash-icon")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  },
);
it("disables the delete action while pending", () => {
  mocks.pending = true;
  render(
    <WorkspaceSessionDeleteItem
      serverId="host"
      workspaceId="w"
      workspaceKey="key"
      surface="dropdown"
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(mocks.remove).not.toHaveBeenCalled();
});
