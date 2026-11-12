import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostFeature } from "@/runtime/host-features";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { useNativeVoicePreference } from "./native-voice-preference";

export function NativeCallSettings({
  serverId,
  agentId,
  onReady,
}: {
  serverId: string;
  agentId?: string;
  onReady?: (ready: boolean) => void;
}) {
  const supported = useHostFeature(serverId, "nativeVoiceCatalog");
  const { t } = useTranslation();
  const voice = useNativeVoicePreference((s) => s.voice);
  const setVoice = useNativeVoicePreference((s) => s.setVoice);
  const client = useHostRuntimeClient(serverId);
  const catalogAgentId = useSessionStore(
    (s) =>
      agentId ??
      [...(s.sessions[serverId]?.agents.values() ?? [])].find((agent) => agent.provider === "codex")
        ?.id,
  );
  const query = useFetchQuery({
    queryKey: ["nativeVoiceCatalog", serverId, catalogAgentId],
    queryFn: async () => {
      if (!client || !catalogAgentId) throw new Error("Codex conversation unavailable");
      return client.listNativeVoiceCatalog(catalogAgentId);
    },
    enabled: Boolean(supported && client && catalogAgentId),
    dataShape: "value",
    retry: false,
    staleTimeMs: 0,
  });
  const { refetch } = query;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  const voices = query.data?.voices ?? [];
  const unavailable = Boolean(query.data && voice && !voices.includes(voice));
  const ready = Boolean(query.data && !unavailable && !query.error);
  useEffect(() => {
    onReady?.(ready);
  }, [ready, onReady]);
  let hint = t("voiceCall.catalogLoading");
  if (!supported) hint = t("settings.voice.updateHost");
  else if (!catalogAgentId) hint = t("voiceCall.catalogNeedsConversation");
  else if (query.error) hint = t("voiceCall.catalogFailed");
  else if (query.data) hint = t("voiceCall.nativeHint");
  return (
    <SettingsSection title={t("voiceCall.nativeTitle")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.voice.voice")}
          hint={hint}
          disabled={!ready && !unavailable}
          value={voice}
          options={[
            { value: "", label: t("voiceCall.providerDefault") },
            ...(voice && !voices.includes(voice)
              ? [{ value: voice, label: t("voiceCall.savedVoiceUnavailable", { voice }) }]
              : []),
            ...voices.map((value) => ({ value, label: value })),
          ]}
          onValueChange={setVoice}
        />
        <View style={styles.info}>
          {unavailable ? (
            <Text style={styles.error} accessibilityRole="alert">
              {t("voiceCall.chooseSupportedVoice", { voice })}
            </Text>
          ) : null}
          <Text style={styles.hint}>{t("voiceCall.nativePreviewHint")}</Text>
          {supported && catalogAgentId ? (
            <Button variant="ghost" onPress={reload}>
              {t("common.actions.retry")}
            </Button>
          ) : null}
        </View>
      </SettingsCard>
    </SettingsSection>
  );
}
const styles = StyleSheet.create((theme) => ({
  info: { padding: theme.spacing[3], gap: theme.spacing[2] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
