import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { AgentList } from "./agent-list";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

const actions = vi.hoisted(() => ({ navigate: vi.fn(), mobile: false }));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: actions.navigate }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => actions.mobile }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/components/provider-icons", () => ({ useProviderIcon: () => () => null }));
vi.mock("@/hooks/use-time-ago", () => ({ useTimeAgo: () => "now" }));
vi.mock("@/hooks/use-archive-agent", () => ({
  useArchiveAgent: () => ({ archiveAgent: vi.fn() }),
}));
vi.mock("@/hooks/use-delete-session-record", () => ({ useDeleteSessionRecord: () => null }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector({ sessions: {} }),
}));
vi.mock("@/default-assistant/lifecycle-controls", () => ({
  AssistantLifecycleControls: () => null,
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? <div data-testid="actions-sheet">{children}</div> : null,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  actions.navigate.mockClear();
  actions.mobile = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await testI18n.changeLanguage("en");
});

const agent = {
  id: "history-agent",
  serverId: "host",
  serverLabel: "Mac",
  workspaceId: "workspace",
  title: "History session",
  provider: "codex",
  status: "idle",
  lastActivityAt: new Date(),
  archivedAt: null,
  labels: {},
} as AggregatedAgent;

function renderHistory(mobile = false) {
  actions.mobile = mobile;
  act(() => root.render(<AgentList agents={[agent]} />));
}
function click(id: string) {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  expect(element).not.toBeNull();
  act(() => element!.click());
}

describe("history row button structure", () => {
  for (const mobile of [false, true]) {
    it(`keeps navigation and actions as separate buttons (${mobile ? "compact" : "desktop"})`, () => {
      renderHistory(mobile);
      expect(container.querySelector("button button")).toBeNull();
      click("agent-row-actions-history-agent");
      expect(container.querySelector('[data-testid="actions-sheet"]')).not.toBeNull();
      expect(actions.navigate).not.toHaveBeenCalled();
      click("agent-action-cancel");
      expect(container.querySelector('[data-testid="actions-sheet"]')).toBeNull();
      click("agent-row-host-history-agent");
      expect(actions.navigate).toHaveBeenCalledExactlyOnceWith({
        serverId: "host",
        agentId: "history-agent",
        workspaceId: "workspace",
        pin: true,
      });
    });
  }
  it("can repeatedly open and dismiss actions without navigating", () => {
    renderHistory();
    for (let i = 0; i < 2; i += 1) {
      click("agent-row-actions-history-agent");
      expect(container.querySelector("button button")).toBeNull();
      click("agent-action-cancel");
    }
    expect(actions.navigate).not.toHaveBeenCalled();
  });
});
