// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "@/i18n/resources/ko";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";
import { SidebarNavRows } from "./sidebar-nav-rows";
import { WorkspaceSessionToolbar } from "@/screens/workspace/workspace-session-toolbar";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("expo-router", () => ({
  router: navigation,
  usePathname: () => "/h/host/workspace/current",
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("lucide-react-native", () => ({
  Plus: () => null,
  CalendarClock: () => null,
  History: () => null,
  MessagesSquare: () => null,
  Search: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "sidebar.actions.addProject") return ko.sidebar.actions.addProject;
      if (key === "workspace.header.actions.newAgent") return ko.workspace.header.actions.newAgent;
      return key;
    },
  }),
}));
vi.mock("@/components/sidebar/sidebar-header-row", () => ({
  SidebarHeaderRow: ({ label, onPress }: { label: string; onPress(): void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress(): void;
    disabled: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/desktop/titlebar-drag-region", () => ({ TitlebarDragRegion: () => null }));
vi.mock("@/hooks/use-shortcut-keys", () => ({ useShortcutKeys: () => null }));
vi.mock("@/plugins/sidebar-items", () => ({ PluginSidebarItem: () => null }));
vi.mock("@/stores/keyboard-shortcuts-store", () => ({ useKeyboardShortcutsStore: vi.fn() }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "host", workspaceId: "existing-workspace" }),
}));
vi.mock("@/sidebar-nav/use-sidebar-nav-items", () => ({
  useSidebarNavItems: () => ({
    items: [{ kind: "builtin", key: "new-project", id: "new-project", visible: true }],
  }),
}));

beforeEach(() => {
  useAddProjectFlowStore.getState().close();
  navigation.push.mockClear();
});
afterEach(cleanup);
describe("creation entry points", () => {
  it("New project opens the project flow on the active host instead of creating a workspace", () => {
    const closeSidebar = vi.fn();
    render(<SidebarNavRows onBeforeNavigate={closeSidebar} />);
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트" }));
    expect(closeSidebar).toHaveBeenCalledOnce();
    expect(useAddProjectFlowStore.getState().request?.preferredHostId).toBe("host");
    expect(navigation.push).not.toHaveBeenCalled();
  });
  it("the header requests a session draft and cannot create while inactive", () => {
    const openSessionDraft = vi.fn();
    const view = render(
      <WorkspaceSessionToolbar onNewSession={openSessionDraft} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "새 에이전트 세션" }));
    expect(openSessionDraft).toHaveBeenCalledOnce();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(useAddProjectFlowStore.getState().request).toBeNull();
    view.rerender(<WorkspaceSessionToolbar onNewSession={openSessionDraft} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "새 에이전트 세션" }));
    expect(openSessionDraft).toHaveBeenCalledOnce();
  });
});
