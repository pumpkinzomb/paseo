import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Index from "../app/index";

const state = vi.hoisted(() => ({
  electron: true,
  hydrated: true,
  demand: vi.fn(),
  expired: false,
  recovery: vi.fn(),
  blocker: "none",
}));
vi.mock("@/hooks/use-workspace-restore-recovery", () => ({
  useWorkspaceRestoreRecovery: (serverId: string | null) => {
    state.recovery(serverId);
    return { needsRecovery: Boolean(serverId && state.expired), retry: vi.fn() };
  },
}));
vi.mock("@/screens/workspace-restore-recovery-screen", () => ({
  WorkspaceRestoreRecoveryScreen: ({ serverId }: { serverId: string }) =>
    React.createElement("aside", null, `Reconnect ${serverId}`),
}));
vi.mock("@/hooks/use-directory-demand", () => ({ useDirectoryDemand: state.demand }));
vi.mock("expo-router", () => ({
  usePathname: () => "/",
  Redirect: ({ href }: { href: string }) => React.createElement("span", null, href),
}));
vi.mock("@/screens/startup-splash-screen", () => ({ StartupSplashScreen: () => null }));
vi.mock("@/app/_layout", () => ({
  useEarliestOnlineHostServerId: () => "server-saved",
  useHostRuntimeBootstrapState: () => ({
    startupBlocker: { kind: state.blocker, message: "Daemon needs attention" },
    hasGivenUpWaitingForHost: false,
    isWaitingForSetup: false,
  }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRegistryStatus: () => "ready",
  useHosts: () => [{ serverId: "server-saved" }],
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useHasHydratedWorkspaces: () => state.hydrated,
  useWorkspaceExists: () => true,
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useIsLastWorkspaceSelectionHydrated: () => true,
  useLastWorkspaceSelection: () => ({ serverId: "server-saved", workspaceId: "workspace-saved" }),
}));
vi.mock("@/desktop/daemon/desktop-daemon", () => ({ shouldUseDesktopDaemon: () => true }));
vi.mock("@/constants/platform", () => ({ getIsElectron: () => state.electron }));

afterEach(() => {
  vi.unstubAllEnvs();
  state.electron = true;
  state.hydrated = true;
  state.demand.mockClear();
  state.expired = false;
  state.recovery.mockClear();
  state.blocker = "none";
});

describe("cold-start index supervision boundary", () => {
  it.each(["managed-daemon-starting", "managed-daemon-error"])(
    "keeps daemon startup UI in charge and disables workspace recovery timer for %s",
    (blocker) => {
      vi.stubEnv("EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL", "supervised-runtime");
      state.blocker = blocker;
      state.hydrated = false;
      state.expired = true;
      expect(renderToStaticMarkup(<Index />)).toBe("");
      expect(state.recovery).toHaveBeenCalledWith(null);
    },
  );
  it.each([
    {
      electron: true,
      label: "supervised-runtime",
      expected: "/h/server-saved/workspace/workspace-saved",
    },
    { electron: true, label: undefined, expected: "/h/server-saved" },
    { electron: true, label: "stable-runtime", expected: "/h/server-saved" },
    { electron: false, label: "supervised-runtime", expected: "/h/server-saved" },
  ])(
    "selects startup route only with Electron supervision: %j",
    ({ electron, label, expected }) => {
      state.electron = electron;
      vi.stubEnv("EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL", label);
      expect(renderToStaticMarkup(<Index />)).toBe(`<span>${expected}</span>`);
      expect(state.demand).toHaveBeenCalledWith(
        electron && label === "supervised-runtime" ? "server-saved" : null,
      );
    },
  );

  it("does not enter the default assistant while the supervised saved workspace is unverified", () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL", "supervised-runtime");
    state.hydrated = false;
    expect(renderToStaticMarkup(<Index />)).toBe("");
    expect(state.demand).toHaveBeenCalledWith("server-saved");
  });

  it("offers saved-host recovery after timeout without selecting another assistant", () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL", "supervised-runtime");
    state.hydrated = false;
    state.expired = true;
    expect(renderToStaticMarkup(<Index />)).toBe("<aside>Reconnect server-saved</aside>");
    expect(state.recovery).toHaveBeenCalledWith("server-saved");
    state.hydrated = true;
    expect(renderToStaticMarkup(<Index />)).toBe(
      "<span>/h/server-saved/workspace/workspace-saved</span>",
    );
  });

  it("does not expose supervised recovery on an ordinary desktop", () => {
    state.hydrated = false;
    state.expired = true;
    expect(renderToStaticMarkup(<Index />)).toBe("<span>/h/server-saved</span>");
    expect(state.recovery).toHaveBeenCalledWith(null);
  });
});
