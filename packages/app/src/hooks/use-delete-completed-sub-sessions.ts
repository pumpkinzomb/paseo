import type { WorkspaceLeadAssociation } from "@getpaseo/protocol/messages";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, getHostRuntimeStore } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { closeSessionTabs, collectSessionWorkspaces } from "@/default-assistant/lifecycle-layout";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { allAgentHistoryQueryRootKey } from "./agent-history-query-key";
import { ASSISTANT_CONVERSATION_QUERY_ROOT } from "@/default-assistant/conversation";

/** Preview every completed group first, then explicitly confirm the union once.
 * This is deliberately not an all-or-nothing server transaction. On a failure we stop,
 * refresh, and never retry a possibly completed deletion. */
export function useDeleteCompletedSubSessions(
  serverId: string,
  parentWorkspaceId: string,
  completedWorkspaceIds: readonly string[],
  onDeleted?: (workspaceIds: readonly string[]) => void,
  options?: {
    restrictToTargets?: boolean;
    ownerKey?: string;
    leadAssociations?: Record<string, WorkspaceLeadAssociation | undefined>;
  },
) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const deletionSupported = useHostFeature(serverId, "workspaceSessionDeletion");
  const associationSupported = useHostFeature(serverId, "workspaceLeadAssociation");
  const scopedAssociations = options?.leadAssociations;
  const supported = deletionSupported && (!scopedAssociations || associationSupported);
  const queryClient = useQueryClient();
  const active = useActiveWorkspaceSelection();
  const activeRef = useRef(active);
  activeRef.current = active;
  const targetKey = JSON.stringify([...new Set(completedWorkspaceIds)].sort());
  const restrictToTargets = options?.restrictToTargets ?? false;
  const scope = `${serverId}:${parentWorkspaceId}:${options?.ownerKey ?? ""}:${restrictToTargets}:${targetKey}:${JSON.stringify(scopedAssociations ?? null)}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(true);
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remove = useCallback(async () => {
    if (!client || !supported || locked.current) return;
    const targets = JSON.parse(targetKey) as string[];
    if (!targets.length || targets.includes(parentWorkspaceId)) return;
    const stillCurrent = () => mounted.current && currentScope.current === scope;
    locked.current = true;
    setPending(true);
    let started = false;
    let awaitingResult = false;
    let removedAny = false;
    const removedWorkspaces = new Set<string>();
    const inspectTargets = async () => {
      const previews = [];
      for (const workspaceId of targets) {
        const historyScope = scopedAssociations
          ? {
              roomWorkspaceId: parentWorkspaceId,
              leadAssociation: scopedAssociations[workspaceId],
              itemKind: "session" as const,
            }
          : undefined;
        const preview = historyScope
          ? await client.inspectWorkspaceSessionDeletion(workspaceId, historyScope)
          : await client.inspectWorkspaceSessionDeletion(workspaceId);
        if (preview.error) throw new Error(preview.error);
        // Refuse old/incompatible or invalid scope instead of risking the parent.
        if (
          (historyScope && (!preview.workspaceRevision || preview.workspaceIds?.length !== 1)) ||
          !preview.workspaceIds?.includes(workspaceId) ||
          preview.workspaceIds.includes(parentWorkspaceId) ||
          (restrictToTargets && preview.workspaceIds.some((id) => !targets.includes(id)))
        ) {
          throw new Error(t("workspaceSessionDeletion.moved"));
        }
        previews.push({ workspaceId, preview, historyScope });
      }
      return previews;
    };
    const finishBatch = async () => {
      if (started) {
        try {
          await queryClient.invalidateQueries({
            queryKey: allAgentHistoryQueryRootKey(),
          });
          await queryClient.invalidateQueries({
            queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId],
          });
          await getHostRuntimeStore().refreshDirectories(serverId);
          const selected = activeRef.current;
          if (selected?.serverId === serverId && removedWorkspaces.has(selected.workspaceId)) {
            redirectIfArchivingActiveWorkspace({
              serverId,
              workspaceId: selected.workspaceId,
              removedWorkspaceIds: [...removedWorkspaces],
              activeWorkspaceSelection: selected,
            });
          }
        } catch {
          toast.error(t("assistantLifecycle.completedRefreshFailed"));
        }
      }
      if (mounted.current && removedWorkspaces.size) onDeleted?.([...removedWorkspaces]);
    };
    try {
      const previews = await inspectTargets();
      if (!stillCurrent()) return;
      const confirmed = await confirmDialog({
        title: t("workspaceSessionDeletion.completedTitle"),
        message: t("workspaceSessionDeletion.completedConfirm", {
          groups: targets.length,
          count: new Set(previews.flatMap(({ preview }) => preview.agentIds)).size,
        }),
        confirmLabel: t("workspaceSessionDeletion.menu"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed || !stillCurrent()) return;
      const owned = collectSessionWorkspaces(serverId);
      for (const { workspaceId, preview, historyScope } of previews) {
        if (removedWorkspaces.has(workspaceId)) continue;
        // Once the confirmed batch starts, directory broadcasts may update the sidebar.
        // Keep its frozen preview, which the server revalidates before each mutation.
        started = true;
        awaitingResult = true;
        const result = historyScope
          ? await client.deleteWorkspaceSessions(
              workspaceId,
              preview.agentIds,
              preview.workspaceIds,
              false,
              { scope: historyScope, revision: preview.workspaceRevision! },
            )
          : await client.deleteWorkspaceSessions(
              workspaceId,
              preview.agentIds,
              preview.workspaceIds,
            );
        awaitingResult = false;
        removedAny ||= result.agentIds.length > 0;
        closeSessionTabs(
          serverId,
          result.agentIds,
          new Map(result.agentIds.map((id) => [id, owned.get(id) ?? workspaceId])),
        );
        if (result.error) throw new Error(result.error);
        for (const id of result.workspaceIds ?? []) removedWorkspaces.add(id);
        removedAny = true;
      }
      toast.show(t("workspaceSessionDeletion.done"), { variant: "success" });
    } catch (error) {
      let messageKey = "workspaceSessionDeletion.moved";
      if (removedAny) messageKey = "workspaceSessionDeletion.partial";
      if (awaitingResult) messageKey = "workspaceSessionDeletion.uncertain";
      toast.error(t(messageKey) + ` ${toErrorMessage(error)}`);
    } finally {
      await finishBatch();
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }, [
    client,
    supported,
    scopedAssociations,
    targetKey,
    restrictToTargets,
    parentWorkspaceId,
    scope,
    t,
    serverId,
    toast,
    queryClient,
    onDeleted,
  ]);
  return {
    remove: supported && completedWorkspaceIds.length ? remove : undefined,
    pending,
  };
}
