import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePaneContext } from "@/panels/pane-context";
import { ArchivedSubSessionHistory } from "./archived-sub-session-dialog";

const history = vi.hoisted(() => vi.fn());
vi.mock("@/default-assistant/conversation", () => ({ useViewedAssistantSegment: history }));
vi.mock("@/panels/agent-panel", () => ({
  AgentConversationPanel: () => {
    const pane = usePaneContext();
    return (
      <div data-testid="history-panel" data-host={pane.host} data-workspace={pane.workspaceId}>
        {pane.target.kind === "agent" ? pane.target.agentId : "wrong target"}
      </div>
    );
  },
}));
vi.mock("@/components/headers/menu-header", () => ({
  MenuHeader: ({ title, rightContent }: { title: string; rightContent: React.ReactNode }) => (
    <header>
      {title}
      {rightContent}
    </header>
  ),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "Close" }) }));
beforeEach(() => {
  vi.stubGlobal("React", React);
  history.mockClear();
});
afterEach(cleanup);

it("subscribes directly to archived agent history without requiring its deleted workspace route", () => {
  const close = vi.fn();
  render(
    <ArchivedSubSessionHistory
      serverId="host"
      workspaceId="removed-worktree"
      agentId="child"
      name="Completed child"
      onClose={close}
    />,
  );
  expect(history).toHaveBeenCalledWith("host", "archived-history:child", "child");
  expect(screen.getByTestId("history-panel").getAttribute("data-host")).toBe("sheet");
  expect(screen.getByTestId("history-panel").textContent).toBe("child");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledTimes(1);
});
