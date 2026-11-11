import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, getHostRuntimeStore } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import {
  useActiveWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { closeSessionTabs, collectSessionWorkspaces } from "@/default-assistant/lifecycle-layout";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { allAgentHistoryQueryRootKey } from "./agent-history-query-key";
import { ASSISTANT_CONVERSATION_QUERY_ROOT } from "@/default-assistant/conversation";

function deletionErrorKey(message: string) {
  if (message.startsWith("Deletion was partially completed"))
    return "workspaceSessionDeletion.partial";
  if (message.startsWith("Deletion result could not be confirmed"))
    return "workspaceSessionDeletion.uncertain";
  if (
    /running work|pending approval|background work|became busy|subagents|still registering/.test(
      message,
    )
  )
    return "workspaceSessionDeletion.busy";
  return null;
}

function redirectDeletedWorkspace(
  serverId: string,
  workspaceId: string,
  scope: string[] | undefined,
  active: ActiveWorkspaceSelection | null,
) {
  const removedWorkspaceIds = scope ?? [workspaceId];
  redirectIfArchivingActiveWorkspace({
    serverId,
    workspaceId:
      active?.serverId === serverId && removedWorkspaceIds.includes(active.workspaceId)
        ? active.workspaceId
        : workspaceId,
    removedWorkspaceIds,
    activeWorkspaceSelection: active,
  });
}

export function useDeleteWorkspaceSessions(
  serverId: string,
  workspaceId: string,
  onDeleted?: () => void,
) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "workspaceSessionDeletion");
  const queryClient = useQueryClient();
  const activeWorkspace = useActiveWorkspaceSelection();
  const activeWorkspaceRef = useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
  const locked = useRef(false);
  const scope = `${serverId}:${workspaceId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remove = useCallback(async () => {
    if (!client || !supported || locked.current) return;
    const requestScope = scope;
    const stillCurrent = () => mounted.current && currentScope.current === requestScope;
    locked.current = true;
    setPending(true);
    let mutationStarted = false;
    let responseReceived = false;
    try {
      // The server inventory includes archived/hidden sessions and children, unlike the sidebar cache.
      const preview = await client.inspectWorkspaceSessionDeletion(workspaceId);
      if (preview.error) throw new Error(preview.error);
      if (!stillCurrent()) return;
      const confirmed = await confirmDialog({
        title: t("workspaceSessionDeletion.title"),
        message: t("workspaceSessionDeletion.confirm", { count: preview.agentIds.length }),
        confirmLabel: t("workspaceSessionDeletion.menu"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed || !stillCurrent()) return;
      const ownedWorkspaces = collectSessionWorkspaces(serverId);
      mutationStarted = true;
      const result = await client.deleteWorkspaceSessions(
        workspaceId,
        preview.agentIds,
        preview.workspaceIds,
      );
      responseReceived = true;
      const workspaces = new Map(
        result.agentIds.map((id) => [id, ownedWorkspaces.get(id) ?? workspaceId]),
      );
      closeSessionTabs(serverId, result.agentIds, workspaces);
      if (!result.error) {
        toast.show(t("workspaceSessionDeletion.done"), { variant: "success" });
        redirectDeletedWorkspace(
          serverId,
          workspaceId,
          result.workspaceIds,
          activeWorkspaceRef.current,
        );
        if (stillCurrent()) onDeleted?.();
      }
      try {
        await queryClient.invalidateQueries({ queryKey: allAgentHistoryQueryRootKey() });
        await queryClient.invalidateQueries({
          queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId],
        });
        await getHostRuntimeStore().refreshDirectories(serverId);
      } catch {
        toast.error(t("assistantLifecycle.completedRefreshFailed"));
      }
      if (result.error) throw new Error(result.error);
    } catch (error) {
      if (mutationStarted && !responseReceived) {
        try {
          await getHostRuntimeStore().refreshDirectories(serverId);
        } catch {
          /* Preserve uncertain outcome. */
        }
        toast.error(t("workspaceSessionDeletion.uncertain"));
        return;
      }
      const message = toErrorMessage(error);
      const key = deletionErrorKey(message);
      toast.error(key ? t(key) : message);
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }, [client, onDeleted, queryClient, scope, serverId, supported, t, toast, workspaceId]);
  return { remove: supported ? remove : undefined, pending };
}
