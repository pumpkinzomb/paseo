import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  useDropdownMenuClose,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useDeleteSessionRecord } from "@/hooks/use-delete-session-record";
import { assistantLifecycleBusy } from "@/default-assistant/lifecycle-policy";

export const WORKSPACE_SESSION_DELETE_PAGE_ID = "workspace-session-delete";
export function sessionsInWorkspace<T extends { serverId: string; workspaceId?: string | null }>(
  agents: readonly T[],
  serverId: string,
  workspaceId: string,
): T[] {
  return agents.filter((agent) => agent.serverId === serverId && agent.workspaceId === workspaceId);
}

function SessionDeleteItem({
  agent,
  workspaceId,
}: {
  agent: AggregatedAgent;
  workspaceId: string;
}) {
  const close = useDropdownMenuClose();
  const remove = useDeleteSessionRecord(agent.serverId, agent.id, close, workspaceId);
  const [pending, setPending] = useState(false);
  const onSelect = useCallback(async () => {
    if (!remove || pending) return;
    setPending(true);
    try {
      await remove();
    } finally {
      setPending(false);
    }
  }, [pending, remove]);
  return (
    <DropdownMenuItem
      testID={`workspace-session-delete-${agent.id}`}
      closeOnSelect={false}
      disabled={!remove || pending || assistantLifecycleBusy(agent.status)}
      onSelect={onSelect}
    >
      {`${agent.title || agent.id} · ${agent.provider} · ${agent.id.slice(0, 8)}`}
    </DropdownMenuItem>
  );
}

export function WorkspaceSessionDeletePage({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const { agents, isInitialLoad } = useAggregatedAgents({
    includeArchived: true,
  });
  const targets = sessionsInWorkspace(agents, serverId, workspaceId);
  return (
    <>
      <DropdownMenuLabel>{t("workspaceSessionDeletion.choose")}</DropdownMenuLabel>
      <DropdownMenuLabel>{t("workspaceSessionDeletion.scope")}</DropdownMenuLabel>
      {targets.map((agent) => (
        <SessionDeleteItem key={agent.id} agent={agent} workspaceId={workspaceId} />
      ))}
      {targets.length === 0 ? (
        <DropdownMenuLabel>
          {t(isInitialLoad ? "workspaceSessionDeletion.loading" : "workspaceSessionDeletion.empty")}
        </DropdownMenuLabel>
      ) : null}
    </>
  );
}

export function useWorkspaceSessionDeletePages(
  target: { serverId: string; workspaceId: string } | null,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      target
        ? [
            {
              id: WORKSPACE_SESSION_DELETE_PAGE_ID,
              title: t("workspaceSessionDeletion.menu"),
              hoverIntent: false,
              content: (
                <WorkspaceSessionDeletePage
                  serverId={target.serverId}
                  workspaceId={target.workspaceId}
                />
              ),
            },
          ]
        : [],
    [t, target],
  );
}
