import { useAssistantConversationContext } from "./conversation";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

/** A native session successor is not the original conversation or a full transcript copy. */
export function AssistantHandoffSource({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const { t } = useTranslation();
  const conversation = useAssistantConversationContext();
  const sourceId = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(agentId)?.labels?.["paseo.handoff.sourceAgentId"],
  );
  const openSource = useCallback(() => {
    if (sourceId) navigateToAgent({ serverId, agentId: sourceId, pin: true });
  }, [serverId, sourceId]);
  if (conversation || !sourceId || sourceId === agentId) return null;
  return (
    <View style={styles.row} testID="assistant-handoff-source">
      <Text style={styles.notice}>{t("defaultAssistant.handoffSourceNotice")}</Text>
      <Button variant="ghost" onPress={openSource} testID="assistant-handoff-open-source">
        {t("defaultAssistant.handoffOpenSource")}
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  notice: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
}));
