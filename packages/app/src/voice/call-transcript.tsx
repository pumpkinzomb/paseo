import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { FileText, Phone } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { collectCallTranscript } from "./call-transcript-model";
import { fetchCallTranscript } from "./fetch-call-transcript";
import { useSessionStore } from "@/stores/session-store";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useFetchQuery } from "@/data/query";

export function CallTranscript({
  serverId,
  agentId,
  callId,
}: {
  serverId: string;
  agentId: string;
  callId?: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const active = useRetainedPanelActive();
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  useEffect(() => setVisible(false), [serverId, agentId, callId]);
  useEffect(() => {
    if (!active) setVisible(false);
  }, [active]);
  const label = t(callId ? "voiceCall.callConnected" : "voiceCall.legacyTranscript");
  const header = useMemo(() => ({ title: label }), [label]);
  return (
    <>
      <Button
        variant="ghost"
        leftIcon={callId ? Phone : FileText}
        onPress={open}
        accessibilityLabel={label}
        testID={callId ? `voice-call-${callId}` : "legacy-call-transcript"}
      >
        {label}
      </Button>
      {visible && active ? (
        <AdaptiveModalSheet visible header={header} onClose={close}>
          <CallTranscriptBody serverId={serverId} agentId={agentId} callId={callId} />
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

export function CallTranscriptBody({
  serverId,
  agentId,
  callId,
}: {
  serverId: string;
  agentId: string;
  callId?: string;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const tail = useSessionStore((s) => s.sessions[serverId]?.agentStreamTail.get(agentId));
  const head = useSessionStore((s) => s.sessions[serverId]?.agentStreamHead.get(agentId));
  const loaded = useMemo(
    () => collectCallTranscript(tail ?? [], head ?? [], callId),
    [tail, head, callId],
  );
  const query = useFetchQuery({
    queryKey: ["voiceCallTranscript", serverId, agentId, callId],
    queryFn: async () => {
      if (!client) throw new Error("Call transcript unavailable");
      return fetchCallTranscript(client.fetchAgentTimeline.bind(client), agentId, callId);
    },
    enabled: Boolean(client),
    dataShape: "value",
    retry: false,
    staleTimeMs: 0,
  });
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const rows = useMemo(() => {
    const result = new Map((query.data ?? []).map((row) => [row.id, row]));
    for (const row of loaded)
      result.set(row.messageId ?? row.id, {
        id: row.messageId ?? row.id,
        role: row.kind === "user_message" ? ("user" as const) : ("assistant" as const),
        text: row.text,
      });
    return [...result.values()];
  }, [query.data, loaded]);
  return (
    <View style={styles.content}>
      <Text style={styles.hint}>
        {t(callId ? "voiceCall.callTranscriptHint" : "voiceCall.legacyTranscriptHint")}
      </Text>
      {(!client || query.error) ? (
        <View>
          <Text style={styles.hint}>{t("voiceCall.transcriptIncomplete")}</Text>
          {client ? (
            <Button variant="ghost" onPress={retry}>
              {t("common.actions.retry")}
            </Button>
          ) : null}
        </View>
      ) : null}
      {client && !query.data && !query.error ? (
        <Text style={styles.hint}>{t("defaultAssistant.historyLoading")}</Text>
      ) : null}
      {rows.length === 0 && query.data ? (
        <Text style={styles.hint}>{t("voiceCall.empty")}</Text>
      ) : null}
      {rows.map((row) => (
        <View key={row.id} style={styles.turn}>
          <Text style={styles.hint}>
            {t(row.role === "user" ? "voiceCall.you" : "voiceCall.assistant")}
          </Text>
          <Text selectable style={styles.text}>
            {row.text}
          </Text>
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[4], gap: theme.spacing[4] },
  turn: { gap: theme.spacing[1] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
