import { previousAssistantSegments } from "./conversation-model";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AssistantConversation } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import { useAssistantConversationContext } from "./conversation";

type Segment = AssistantConversation["segments"][number];
type Cursor = NonNullable<Parameters<DaemonClient["fetchAgentTimeline"]>[1]>["cursor"];

export function AssistantConversationHistory({ serverId }: { serverId: string }) {
  const conversation = useAssistantConversationContext();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  useEffect(
    () => setExpanded(false),
    [serverId, conversation?.logicalId, conversation?.activeAgentId],
  );
  const previous = useMemo(() => previousAssistantSegments(conversation), [conversation]);
  if (!previous.length) return null;
  return (
    <View style={styles.container} testID="assistant-conversation-history">
      <Button variant="ghost" onPress={toggle} testID="assistant-history-toggle">
        {t("defaultAssistant.historyTitle", { count: previous.length })}
      </Button>
      {expanded ? (
        <ScrollView style={styles.history} nestedScrollEnabled>
          <Text style={styles.notice}>{t("defaultAssistant.historyNotice")}</Text>
          {previous.map((segment, index) => (
            <HistorySegment
              key={segment.agentId}
              serverId={serverId}
              segment={segment}
              index={index}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function HistorySegment({
  serverId,
  segment,
  index,
}: {
  serverId: string;
  segment: Segment;
  index: number;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.segment} testID={`assistant-history-segment-${segment.agentId}`}>
      <Text style={styles.heading}>
        {t("defaultAssistant.historySegment", {
          index: index + 1,
          provider: segment.provider,
          model: segment.model ?? "",
        })}
      </Text>
      <HistoryPage serverId={serverId} agentId={segment.agentId} />
    </View>
  );
}

function HistoryPage({
  serverId,
  agentId,
  cursor,
}: {
  serverId: string;
  agentId: string;
  cursor?: Cursor;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [older, setOlder] = useState(false);
  const loadOlder = useCallback(() => setOlder(true), []);
  const query = useFetchQuery({
    queryKey: ["assistantSegmentHistory", serverId, agentId, cursor ?? null],
    queryFn: async () => {
      if (!client) throw new Error(t("defaultAssistant.handoffDisconnected"));
      const result = await client.fetchAgentTimeline(agentId, {
        direction: cursor ? "before" : "tail",
        cursor,
        limit: 100,
      });
      if (result.error) throw new Error(result.error);
      if (result.gap || result.staleCursor)
        throw new Error(t("defaultAssistant.handoffIncomplete"));
      return result;
    },
    dataShape: "value",
    staleTimeMs: 30_000,
    enabled: Boolean(client),
    retry: false,
  });
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (query.error)
    return (
      <View>
        <Text style={styles.notice}>{toErrorMessage(query.error)}</Text>
        <Button variant="ghost" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  if (!query.data) return <Text style={styles.notice}>{t("defaultAssistant.historyLoading")}</Text>;
  const page = query.data;
  return (
    <View>
      {page.hasOlder && page.startCursor && older ? (
        <HistoryPage serverId={serverId} agentId={agentId} cursor={page.startCursor} />
      ) : null}
      {page.hasOlder && page.startCursor && !older ? (
        <Button variant="ghost" onPress={loadOlder}>
          {t("defaultAssistant.historyOlder")}
        </Button>
      ) : null}
      {page.entries.map((entry) => {
        const item = entry.item;
        if (
          (item.type !== "user_message" && item.type !== "assistant_message") ||
          typeof item.text !== "string"
        )
          return null;
        return (
          <View key={`${entry.seqStart}:${entry.seqEnd}`} style={styles.message}>
            <Text style={styles.role}>
              {item.type === "user_message"
                ? t("defaultAssistant.historyUser")
                : t("defaultAssistant.title")}
            </Text>
            <Text selectable style={styles.text}>
              {item.text}
            </Text>
          </View>
        );
      })}
      {!page.entries.length ? (
        <Text style={styles.notice}>{t("defaultAssistant.historyEmpty")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { borderBottomWidth: 1, borderColor: theme.colors.border },
  history: { maxHeight: 300 },
  segment: { padding: theme.spacing[3], borderTopWidth: 1, borderColor: theme.colors.border },
  heading: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    marginBottom: theme.spacing[2],
  },
  message: { paddingVertical: theme.spacing[2] },
  role: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
}));
