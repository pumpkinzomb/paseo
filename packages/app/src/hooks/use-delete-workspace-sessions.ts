import type { WorkspaceHistoryScope } from "@getpaseo/protocol/messages";
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

type DeletionClient = NonNullable<ReturnType<typeof useHostRuntimeClient>>;
type DeletionPreview = Awaited<ReturnType<DeletionClient["inspectWorkspaceSessionDeletion"]>>;
const HISTORY_CONFIRMATION = {
  title: "workspaceSessionDeletion.historyTitle",
  message: "workspaceSessionDeletion.historyConfirm",
  action: "workspaceSessionDeletion.historyMenu",
} as const;
const SESSION_CONFIRMATION = {
  title: "workspaceSessionDeletion.title",
  message: "workspaceSessionDeletion.nativeConfirm",
  action: "workspaceSessionDeletion.menu",
} as const;
async function inspectDeletion(
  client: DeletionClient,
  workspaceId: string,
  historyScope: WorkspaceHistoryScope | undefined,
  scopeError: string,
) {
  const preview = historyScope
    ? await client.inspectWorkspaceSessionDeletion(workspaceId, historyScope)
    : await client.inspectWorkspaceSessionDeletion(workspaceId);
  if (preview.error) throw new Error(preview.error);
  if (
    historyScope &&
    (!preview.workspaceRevision ||
      preview.workspaceIds?.length !== 1 ||
      preview.workspaceIds[0] !== workspaceId)
  )
    throw new Error(scopeError);
  return preview;
}
function applyDeletion(
  client: DeletionClient,
  workspaceId: string,
  preview: DeletionPreview,
  historyScope: WorkspaceHistoryScope | undefined,
) {
  if (historyScope)
    return client.deleteWorkspaceSessions(
      workspaceId,
      preview.agentIds,
      preview.workspaceIds,
      preview.agentIds.length > 0,
      { scope: historyScope, revision: preview.workspaceRevision! },
    );
  return client.deleteWorkspaceSessions(workspaceId, preview.agentIds, preview.workspaceIds, true);
}

export function useDeleteWorkspaceSessions(
  serverId: string,
  workspaceId: string,
  onDeleted?: () => void,
  options?: { historyScope: WorkspaceHistoryScope },
) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const nativeSupported = useHostFeature(serverId, "nativeSessionDeletion");
  const associationSupported = useHostFeature(serverId, "workspaceLeadAssociation");
  const historyScope = options?.historyScope;
  const confirmation = historyScope ? HISTORY_CONFIRMATION : SESSION_CONFIRMATION;
  const supported = nativeSupported && (!historyScope || associationSupported);
  const queryClient = useQueryClient();
  const activeWorkspace = useActiveWorkspaceSelection();
  const activeWorkspaceRef = useRef(activeWorkspace);
  activeWorkspaceRef.current = activeWorkspace;
  const locked = useRef(false);
  const scope = `${serverId}:${workspaceId}:${JSON.stringify(historyScope ?? null)}`;
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
      const preview = await inspectDeletion(
        client,
        workspaceId,
        historyScope,
        t("workspaceSessionDeletion.moved"),
      );
      if (!stillCurrent()) return;
      const confirmed = await confirmDialog({
        title: t(confirmation.title),
        message: t(confirmation.message, { count: preview.agentIds.length }),
        confirmLabel: t(confirmation.action),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed || !stillCurrent()) return;
      const ownedWorkspaces = collectSessionWorkspaces(serverId);
      mutationStarted = true;
      const result = await applyDeletion(client, workspaceId, preview, historyScope);
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
  }, [
    client,
    historyScope,
    confirmation,
    onDeleted,
    queryClient,
    scope,
    serverId,
    supported,
    t,
    toast,
    workspaceId,
  ]);
  return { remove: supported ? remove : undefined, pending };
}
