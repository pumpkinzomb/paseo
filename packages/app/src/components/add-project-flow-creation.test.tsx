// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "@/i18n/resources/ko";
import { AddProjectFlow } from "./add-project-flow";

const fixture = vi.hoisted(() => ({
  hosts: [{ serverId: "host", label: "Local" }],
  features: new Map([["host", true]]),
  connections: new Map([["host", "online"]]),
  paths: [],
  openProject: vi.fn(),
  success: vi.fn(),
  push: vi.fn(),
  hydrate: vi.fn(),
}));
vi.mock("expo-router", () => ({ router: { push: fixture.push } }));
vi.mock("@/hooks/use-open-project", () => ({
  useOpenProject: () => fixture.openProject,
  useCloneGithubProject: () => vi.fn(),
}));
vi.mock("@/hooks/open-project", () => ({
  getOpenProjectFailureReason: () => "directory_not_found",
  registerProjectDescriptor: vi.fn(),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: fixture.success }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { projectName?: string }) => {
      if (key === "sidebar.actions.addProject") return ko.sidebar.actions.addProject;
      if (key === "sidebar.project.toasts.added")
        return ko.sidebar.project.toasts.added.replace(
          "{{projectName}}",
          options?.projectName ?? "",
        );
      return key;
    },
  }),
}));
vi.mock("react-native", () => {
  function Container({ children }: { children?: ReactNode }) {
    return <div>{children}</div>;
  }
  function Pressable({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode | ((state: { hovered: boolean; pressed: boolean }) => ReactNode);
    onPress?(): void;
    disabled?: boolean;
  }) {
    return (
      <button type="button" disabled={disabled} onClick={onPress}>
        {typeof children === "function" ? children({ hovered: false, pressed: false }) : children}
      </button>
    );
  }
  return { View: Container, Text: Container, ScrollView: Container, Pressable };
});
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: unknown) => component,
}));
vi.mock("lucide-react-native", () => ({
  ArrowLeft: () => null,
  Folder: () => null,
  FolderOpen: () => null,
  FolderPlus: () => null,
  HardDrive: () => null,
  Plus: () => null,
  Search: () => null,
  Server: () => null,
}));
vi.mock("@/components/icons/github-icon", () => ({ GitHubIcon: () => null }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/text-input", () => ({ EditingTextInput: () => null }));
vi.mock("@/components/ui/shortcut", () => ({ Shortcut: () => null }));
vi.mock("@/keyboard", () => ({
  useOverlayRegistration: () => vi.fn(),
  useHardwareKeyboardPresent: () => false,
}));
vi.mock("@/hosts/add-host", () => ({ useAddHost: () => vi.fn() }));
vi.mock("@/constants/layout", () => ({ getIsElectronRuntime: () => true }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/desktop/pick-directory", () => ({ pickDirectory: async () => "/project" }));
vi.mock("@/data/query", () => ({
  useFetchQuery: () => ({ data: undefined, error: null, isLoading: false }),
}));
vi.mock("@/hooks/use-is-local-daemon", () => ({
  useIsLocalDaemon: () => true,
  useLocalDaemonServerId: () => "host",
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => fixture.hosts,
  useHostRuntimeClient: () => null,
  useHostRuntimeConnectionStatuses: () => fixture.connections,
  getHostRuntimeStore: () => ({ acceptProjectSnapshot: vi.fn() }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeatureMap: () => fixture.features }));
vi.mock("@/stores/session-store-hooks", () => ({
  useRecommendedProjectPaths: () => fixture.paths,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: { setHasHydratedWorkspaces: typeof fixture.hydrate }) => unknown,
  ) => selector({ setHasHydratedWorkspaces: fixture.hydrate }),
}));
vi.mock("@/lib/overlay-root", () => ({
  OverlayLayerProvider: ({ children }: { children: ReactNode }) => children,
  useGlobalOverlayLayer: () => 1,
}));
vi.mock("@/components/ui/scroll-reveal", () => ({
  useRevealActiveItem: () => ({
    activeItemRef: { current: null },
    contentRef: { current: null },
    onItemLayout: vi.fn(),
    onViewportLayout: vi.fn(),
    onScroll: vi.fn(),
  }),
}));

const PROJECT_REQUEST = { id: 1, preferredHostId: "host" };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);
describe("project creation completion", () => {
  it("finishes project registration without opening workspace or agent creation", async () => {
    fixture.openProject.mockResolvedValue({ ok: true, project: { projectDisplayName: "Example" } });
    const close = vi.fn();
    render(<AddProjectFlow request={PROJECT_REQUEST} onClose={close} />);
    expect(screen.getByText("새 프로젝트").textContent).toBe("새 프로젝트");
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(fixture.openProject).toHaveBeenCalledWith("/project");
    expect(fixture.success).toHaveBeenCalledExactlyOnceWith("프로젝트를 추가했어요: Example", {
      variant: "success",
    });
    expect(fixture.push).not.toHaveBeenCalled();
  });
  it("keeps registration open with a visible failure instead of advancing to workspace setup", async () => {
    fixture.openProject.mockResolvedValue({ ok: false });
    const close = vi.fn();
    render(<AddProjectFlow request={PROJECT_REQUEST} onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    await screen.findByText("Directory not found");
    expect(close).not.toHaveBeenCalled();
    expect(fixture.success).not.toHaveBeenCalled();
    expect(fixture.push).not.toHaveBeenCalled();
  });
});
