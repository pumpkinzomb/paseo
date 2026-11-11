import { useCallback } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ArchivedSubSessionHistory } from "@/components/sidebar/archived-sub-session-dialog";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildHostRootRoute } from "@/utils/host-routes";

/** A normal host route keeps app chrome/sidebar mounted; no disposed project lookup. */
export default function ArchivedSubSessionHistoryRoute() {
  const params = useLocalSearchParams<{
    serverId: string;
    agentId: string;
    workspaceId?: string;
    parentWorkspaceId?: string;
    name?: string;
  }>();
  const router = useRouter();
  const close = useCallback(() => {
    if (params.parentWorkspaceId) {
      navigateToWorkspace({
        serverId: params.serverId,
        workspaceId: params.parentWorkspaceId,
      });
    } else if (router.canGoBack()) router.back();
    else router.replace(buildHostRootRoute(params.serverId));
  }, [params.parentWorkspaceId, params.serverId, router]);
  return (
    <HostRouteBootstrapBoundary>
      <ArchivedSubSessionHistory
        serverId={params.serverId}
        workspaceId={params.workspaceId ?? ""}
        agentId={params.agentId}
        name={params.name ?? params.agentId}
        onClose={close}
      />
    </HostRouteBootstrapBoundary>
  );
}
