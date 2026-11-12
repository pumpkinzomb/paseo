import { navigateAssistantConversation } from "./conversation-navigation";
import { ASSISTANT_CONVERSATION_QUERY_ROOT, cacheAssistantConversation } from "./conversation";
import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SettingsTextArea } from "@/components/settings-textarea";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { toErrorMessage } from "@/utils/error-messages";
import type { AssistantModelSelection } from "./model-selection";
import { buildContinuedAssistantHandoffDraft } from "./handoff-draft";

interface HandoffPreviewProps {
  serverId: string;
  sourceAgentId: string;
  selection: AssistantModelSelection;
  purpose?: "isolation";
  onClose: () => void;
}

export function AssistantHandoffPreview(props: HandoffPreviewProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(props.serverId);
  const supportsConversations = useHostFeature(props.serverId, "defaultAssistantConversations");
  const [requestId] = useState(randomUUID);
  const [submitting, setSubmitting] = useState(false);
  const { onClose } = props;
  const close = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);
  const query = useFetchQuery({
    queryKey: ["assistant-handoff-preview", props.serverId, props.sourceAgentId, requestId],
    queryFn: async () => {
      if (!client) throw new Error(t("defaultAssistant.handoffDisconnected"));
      const timeline = await client.fetchAgentTimeline(props.sourceAgentId, {
        direction: "tail",
        limit: 100,
      });
      if (timeline.error) throw new Error(timeline.error);
      if (timeline.gap || timeline.staleCursor)
        throw new Error(t("defaultAssistant.handoffIncomplete"));
      const source = timeline.agent;
      if (!source) throw new Error(t("defaultAssistant.handoffSourceMissing"));
      const logical = supportsConversations
        ? await client.getDefaultAssistantConversation({ agentId: props.sourceAgentId })
        : null;
      if (logical?.error) throw new Error(logical.error);
      const reviewedContext = logical?.conversation?.segments.find(
        (segment) => segment.agentId === props.sourceAgentId,
      )?.reviewedContext;
      const draft = buildContinuedAssistantHandoffDraft(timeline.entries, reviewedContext);
      return {
        sourceUpdatedAt: source.updatedAt,
        draft: { ...draft, truncated: draft.truncated || timeline.hasOlder },
      };
    },
    enabled: Boolean(client),
    retry: false,
    refetchOnWindowFocus: false,
    staleTimeMs: 300_000,
    refetchOnReconnect: false,
    dataShape: "value",
    gcTime: 0,
  });
  const header = useMemo(
    () => ({
      title: t(
        props.purpose === "isolation"
          ? "defaultAssistant.isolationTitle"
          : "defaultAssistant.handoffTitle",
      ),
    }),
    [props.purpose, t],
  );
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={header}
      desktopMaxWidth={680}
      testID="assistant-handoff-preview"
    >
      <Text style={styles.notice}>
        {t("defaultAssistant.handoffNotice", {
          provider: props.selection.provider,
          model: props.selection.model,
        })}
      </Text>
      {props.purpose === "isolation" ? (
        <Text style={styles.notice}>{t("defaultAssistant.isolationPreviewNotice")}</Text>
      ) : null}
      {query.data ? (
        <>
          <Text style={styles.notice}>
            {t("defaultAssistant.handoffCounts", {
              included: query.data.draft.includedMessages,
              omitted: query.data.draft.omittedMessages,
              sensitive: query.data.draft.sensitiveMessages,
              truncated: query.data.draft.truncated
                ? t("defaultAssistant.handoffOmittedYes")
                : t("defaultAssistant.handoffOmittedNo"),
            })}
          </Text>
          <HandoffEditor
            {...props}
            onPendingChange={setSubmitting}
            requestId={requestId}
            sourceUpdatedAt={query.data.sourceUpdatedAt}
            initialText={query.data.draft.text}
          />
        </>
      ) : (
        <View style={styles.actions}>
          <Text style={styles.notice}>
            {query.error ? toErrorMessage(query.error) : t("defaultAssistant.handoffLoading")}
          </Text>
          <Button variant="outline" onPress={props.onClose}>
            {t("common.actions.cancel")}
          </Button>
          {query.error ? <Button onPress={retry}>{t("common.actions.retry")}</Button> : null}
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

function HandoffEditor({
  serverId,
  sourceAgentId,
  selection,
  onClose,
  requestId,
  sourceUpdatedAt,
  initialText,
  onPendingChange,
}: HandoffPreviewProps & {
  requestId: string;
  sourceUpdatedAt: string;
  initialText: string;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [text, setText] = useState(initialText);
  const queryClient = useQueryClient();
  const active = useRef(true);
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      return () => {
        active.current = false;
      };
    }, []),
  );
  const mutation = useMutation({
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    mutationFn: async () => {
      if (!client) throw new Error(t("defaultAssistant.handoffDisconnected"));
      const result = await client.ensureDefaultAssistant({
        newSession: true,
        requestId,
        provider: selection.provider,
        model: selection.model,
        handoff: { sourceAgentId, sourceUpdatedAt, text: text.trim() },
      });
      if (result.error || !result.agent || !result.workspace)
        throw new Error(result.error ?? t("defaultAssistant.handoffSourceMissing"));
      if (result.conversation)
        await cacheAssistantConversation(queryClient, serverId, result.conversation);
      if (active.current) {
        onClose();
        void queryClient.invalidateQueries({
          queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId],
        });
        if (result.conversation)
          navigateAssistantConversation({ serverId, conversation: result.conversation });
        else
          navigateToAgent({
            serverId,
            agentId: result.agent.id,
            workspaceId: result.workspace.id,
            pin: true,
          });
      }
    },
  });
  const { mutate } = mutation;
  const submit = useCallback(() => mutate(), [mutate]);
  return (
    <View>
      <SettingsTextArea
        value={text}
        onChangeText={setText}
        accessibilityLabel={t("defaultAssistant.handoffTextLabel")}
        testID="assistant-handoff-text"
        style={styles.editor}
      />
      <Text style={styles.notice}>
        {text.length} / 12000 · {t("defaultAssistant.handoffReviewNotice")}
      </Text>
      {mutation.error ? <Text style={styles.error}>{toErrorMessage(mutation.error)}</Text> : null}
      <View style={styles.actions}>
        <Button variant="outline" onPress={onClose} disabled={mutation.isPending}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          onPress={submit}
          disabled={mutation.isPending || !text.trim() || text.length > 12000}
          testID="assistant-handoff-confirm"
        >
          {t("defaultAssistant.handoffConfirm")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
  },
  editor: {
    minHeight: 220,
    maxHeight: 360,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  error: { color: theme.colors.destructive, marginBottom: theme.spacing[3] },
}));
