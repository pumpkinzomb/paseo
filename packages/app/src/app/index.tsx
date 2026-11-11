import React from "react";
import { Redirect, usePathname } from "expo-router";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useEarliestOnlineHostServerId, useHostRuntimeBootstrapState } from "@/app/_layout";
import {
  resolveStartupRoute,
  resolveWorkspaceSelectionStatus,
} from "@/navigation/host-runtime-bootstrap";
import { useHostRegistryStatus, useHosts } from "@/runtime/host-runtime";
import { useHasHydratedWorkspaces, useWorkspaceExists } from "@/stores/session-store-hooks";
import {
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { getIsElectron } from "@/constants/platform";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useWorkspaceRestoreRecovery } from "@/hooks/use-workspace-restore-recovery";
import { WorkspaceRestoreRecoveryScreen } from "@/screens/workspace-restore-recovery-screen";

const isDesktop = shouldUseDesktopDaemon();

export default function Index() {
  const pathname = usePathname();
  const bootstrapState = useHostRuntimeBootstrapState();
  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const hosts = useHosts();
  const hostRegistryStatus = useHostRegistryStatus();
  const workspaceSelection = useLastWorkspaceSelection();
  const isWorkspaceSelectionLoaded = useIsLastWorkspaceSelectionHydrated();
  const workspaceSelectionServerId = workspaceSelection?.serverId ?? null;
  const workspaceSelectionWorkspaceId = workspaceSelection?.workspaceId ?? null;
  const restoreDesktopWorkspace =
    getIsElectron() && process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL === "supervised-runtime";
  // A hidden/compact sidebar may not request any directory. Demand the saved
  // host explicitly rather than waiting on hydration that never starts.
  const savedHostForRestore =
    restoreDesktopWorkspace &&
    hostRegistryStatus === "ready" &&
    hosts.some((host) => host.serverId === workspaceSelectionServerId)
      ? workspaceSelectionServerId
      : null;
  useDirectoryDemand(savedHostForRestore);
  const hasHydratedWorkspaceSelectionHost = useHasHydratedWorkspaces(workspaceSelectionServerId);
  const workspaceSelectionExists = useWorkspaceExists(
    workspaceSelectionServerId,
    workspaceSelectionWorkspaceId,
  );

  const startupRoute = resolveStartupRoute({
    route: { kind: "index", pathname },
    restoreDesktopWorkspace,
    startupBlocker: bootstrapState.startupBlocker,
    hostRegistryStatus,
    hosts,
    anyOnlineHostServerId,
    workspaceSelection,
    workspaceSelectionStatus: resolveWorkspaceSelectionStatus({
      hasHydratedWorkspaces: hasHydratedWorkspaceSelectionHost,
      workspaceExists: workspaceSelectionExists,
    }),
    isWorkspaceSelectionLoaded,
    hasHydratedWorkspaceSelectionHost,
    hasGivenUpWaitingForHost: bootstrapState.hasGivenUpWaitingForHost,
    isWaitingForSetup: bootstrapState.isWaitingForSetup,
  });

  const waitingForSavedWorkspace =
    savedHostForRestore !== null &&
    bootstrapState.startupBlocker.kind === "none" &&
    (pathname === "/" || pathname === "") &&
    isWorkspaceSelectionLoaded &&
    !hasHydratedWorkspaceSelectionHost;
  const recovery = useWorkspaceRestoreRecovery(
    waitingForSavedWorkspace ? workspaceSelectionServerId : null,
  );
  if (recovery.needsRecovery && workspaceSelectionServerId) {
    return (
      <WorkspaceRestoreRecoveryScreen
        serverId={workspaceSelectionServerId}
        retry={recovery.retry}
      />
    );
  }

  const splash = <StartupSplashScreen bootstrapState={isDesktop ? bootstrapState : undefined} />;
  if (startupRoute.kind === "redirect") {
    // The loading screen stays up until the target route paints; a redirect alone renders nothing.
    return (
      <>
        {splash}
        <Redirect href={startupRoute.href} />
      </>
    );
  }

  return splash;
}
