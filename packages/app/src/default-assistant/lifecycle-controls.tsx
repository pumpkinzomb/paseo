import { confirmAssistantLifecycle } from "./lifecycle-action";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient, getHostRuntimeStore } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { closeSessionTabs, collectSessionWorkspaces } from "./lifecycle-layout";
import { ASSISTANT_CONVERSATION_QUERY_ROOT, useAssistantConversationContext } from "./conversation";
import {
  assistantLifecycleActions,
  assistantLifecycleBusy,
  type AssistantLifecycleAction,
} from "./lifecycle-policy";

export function AssistantLifecycleControls({
  serverId,
  agentId,
  archived,
  status,
  onClose,
  onDone,
}: {
  serverId: string;
  agentId: string;
  archived: boolean;
  status?: string;
  onClose?: () => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "assistantConversationLifecycle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const queryClient = useQueryClient();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = assistantLifecycleBusy(status);
  const run = useCallback(
    async (action: AssistantLifecycleAction) => {
      if (lock.current || !client || busy || !supported) return;
      lock.current = true;
      setPending(true);
      setError(null);
      try {
        const workspaceByAgent = collectSessionWorkspaces(serverId);
        const result = await confirmAssistantLifecycle({
          action,
          stillActive: () => mounted.current,
          confirm: () =>
            confirmDialog({
              title: t(`assistantLifecycle.${action}`),
              message: t(`assistantLifecycle.${action}Confirm`),
              confirmLabel: t(`assistantLifecycle.${action}`),
              cancelLabel: t("common.actions.cancel"),
              destructive: action === "delete",
            }),
          mutate: (confirmedAction) => client.mutateAssistantConversation(agentId, confirmedAction),
        });
        if (!result) return;
        if (result.error) throw new Error(result.error);
        if (action !== "restore") {
          closeSessionTabs(serverId, result.agentIds, workspaceByAgent);
        }
        try {
          await queryClient.invalidateQueries({
            queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId],
          });
          await getHostRuntimeStore().refreshDirectories(serverId);
        } catch {
          setError(t("assistantLifecycle.completedRefreshFailed"));
        }
        onDone?.();
      } catch (cause) {
        setError(toErrorMessage(cause));
      } finally {
        lock.current = false;
        setPending(false);
      }
    },
    [agentId, busy, client, onDone, queryClient, serverId, supported, t],
  );
  const archive = useCallback(() => {
    void run("archive");
  }, [run]);
  const restore = useCallback(() => {
    void run("restore");
  }, [run]);
  const remove = useCallback(() => {
    void run("delete");
  }, [run]);
  const handlers = { archive, restore, delete: remove };
  if (!supported)
    return (
      <View style={styles.container}>
        <Text style={styles.notice}>{t("defaultAssistant.updateHost")}</Text>
        {onClose ? (
          <Button variant="ghost" onPress={onClose}>
            {t("common.actions.cancel")}
          </Button>
        ) : null}
      </View>
    );
  return (
    <View style={styles.container} testID="assistant-lifecycle-controls">
      <Text style={styles.notice}>{t("assistantLifecycle.scope")}</Text>
      <View style={styles.actions}>
        {onClose ? (
          <Button variant="ghost" onPress={onClose} disabled={pending}>
            {t("assistantLifecycle.close")}
          </Button>
        ) : null}
        {assistantLifecycleActions(archived).map((action) => (
          <Button
            key={action}
            variant="ghost"
            onPress={handlers[action]}
            disabled={pending || busy || !client}
            testID={`assistant-lifecycle-${action}`}
          >
            {t(`assistantLifecycle.${action}`)}
          </Button>
        ))}
      </View>
      {busy ? <Text style={styles.notice}>{t("assistantLifecycle.busy")}</Text> : null}
      {error ? (
        <Text style={styles.error} testID="assistant-lifecycle-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function AssistantPaneLifecycle({ serverId }: { serverId: string }) {
  const conversation = useAssistantConversationContext();
  const supported = useHostFeature(serverId, "assistantConversationLifecycle");
  const pane = usePaneContext();
  const agent = useSessionStore((state) =>
    conversation ? state.sessions[serverId]?.agents.get(conversation.activeAgentId) : undefined,
  );
  if (!conversation || !supported) return null;
  return (
    <AssistantLifecycleControls
      serverId={serverId}
      agentId={conversation.activeAgentId}
      archived={Boolean(agent?.archivedAt)}
      status={agent?.status}
      onClose={pane.closeCurrentTab}
    />
  );
}
const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1],
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
