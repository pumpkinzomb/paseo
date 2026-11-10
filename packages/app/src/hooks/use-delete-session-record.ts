import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, getHostRuntimeStore } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { closeSessionTabs, collectSessionWorkspaces } from "@/default-assistant/lifecycle-layout";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { allAgentHistoryQueryRootKey } from "./agent-history-query-key";
import { ASSISTANT_CONVERSATION_QUERY_ROOT } from "@/default-assistant/conversation";

/** One visible session action. Managers route through whole-conversation lifecycle, never raw deletion. */
export function useDeleteSessionRecord(serverId: string, agentId?: string, onDeleted?: () => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const normalSupported = useHostFeature(serverId, "agentRecordDeletion");
  const assistantSupported = useHostFeature(serverId, "assistantConversationLifecycle");
  const isAssistant = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return agentId
      ? (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.labels?.[
          "paseo.role"
        ] === "assistant"
      : false;
  });
  const supported = isAssistant ? assistantSupported : normalSupported;
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remove = useCallback(async () => {
    if (!client || !agentId || !supported || locked.current) return;
    locked.current = true;
    try {
      const current = await client.fetchAgent({ agentId });
      if (!current) throw new Error(t("sessionRecordDeletion.notFound"));
      const manager = current.agent.labels?.["paseo.role"] === "assistant";
      const confirmed = await confirmDialog({
        title: t(manager ? "assistantLifecycle.delete" : "sessionRecordDeletion.title"),
        message: t(manager ? "assistantLifecycle.deleteConfirm" : "sessionRecordDeletion.confirm"),
        confirmLabel: t("assistantLifecycle.delete"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed || !mounted.current) return;
      const workspaces = collectSessionWorkspaces(serverId);
      if (current.agent.workspaceId) workspaces.set(agentId, current.agent.workspaceId);
      const result = manager
        ? await client.mutateAssistantConversation(agentId, "delete")
        : await client.deleteAgentRecord(agentId);
      if (result.error) throw new Error(result.error);
      closeSessionTabs(serverId, result.agentIds, workspaces);
      toast.show(t("sessionRecordDeletion.done"), { variant: "success" });
      onDeleted?.();
      try {
        await queryClient.invalidateQueries({ queryKey: allAgentHistoryQueryRootKey() });
        await queryClient.invalidateQueries({
          queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId],
        });
        await getHostRuntimeStore().refreshDirectories(serverId);
      } catch {
        toast.error(t("assistantLifecycle.completedRefreshFailed"));
      }
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      locked.current = false;
    }
  }, [agentId, client, onDeleted, queryClient, serverId, supported, t, toast]);
  return supported && agentId ? remove : undefined;
}
