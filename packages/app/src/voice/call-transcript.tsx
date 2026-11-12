import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { collectCallTranscript } from "./call-transcript-model";
import { useSessionStore } from "@/stores/session-store";

export function CallTranscript({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const header = useMemo(() => ({ title: t("voiceCall.transcript") }), [t]);
  const tail = useSessionStore((s) => s.sessions[serverId]?.agentStreamTail.get(agentId));
  const head = useSessionStore((s) => s.sessions[serverId]?.agentStreamHead.get(agentId));
  const rows = useMemo(() => collectCallTranscript(tail ?? [], head ?? []), [tail, head]);
  return (
    <>
      <Button
        variant="ghost"
        leftIcon={FileText}
        onPress={open}
        accessibilityLabel={t("voiceCall.transcript")}
      >
        {t("voiceCall.transcript")}
      </Button>
      <AdaptiveModalSheet visible={visible} header={header} onClose={close}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.hint}>{t("voiceCall.transcriptHint")}</Text>
          {rows.length === 0 ? <Text style={styles.hint}>{t("voiceCall.empty")}</Text> : null}
          {rows.map((row) =>
            row.kind === "user_message" || row.kind === "assistant_message" ? (
              <View key={row.messageId ?? row.id} style={styles.turn}>
                <Text style={styles.hint}>
                  {t(row.kind === "user_message" ? "voiceCall.you" : "voiceCall.assistant")}
                </Text>
                <Text selectable style={styles.text}>
                  {row.text}
                </Text>
              </View>
            ) : null,
          )}
        </ScrollView>
      </AdaptiveModalSheet>
    </>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[4], gap: theme.spacing[4] },
  turn: { gap: theme.spacing[1] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
