import { useCallback, useEffect } from "react";
import { ChevronDown } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuHint,
} from "@/components/ui/dropdown-menu";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useHostFeature } from "@/runtime/host-features";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { useNativeVoicePreference } from "./native-voice-preference";

const ThemedChevronDown = withUnistyles(ChevronDown);
const chevronColor = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function NativeCallSettings({
  serverId,
  agentId,
  onReady,
  inline = false,
  currentVoice,
  disabled = false,
}: {
  serverId: string;
  agentId?: string;
  onReady?: (ready: boolean) => void;
  inline?: boolean;
  currentVoice?: string;
  disabled?: boolean;
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
  const hintKey = catalogHint(
    supported,
    Boolean(catalogAgentId),
    Boolean(query.error),
    Boolean(query.data),
  );
  const hint = t(hintKey);
  if (inline) {
    return (
      <InlineVoicePicker
        voice={voice}
        currentVoice={currentVoice}
        setVoice={setVoice}
        disabled={disabled}
        voices={voices}
        available={Boolean(query.data && !query.error)}
        failed={Boolean(query.error)}
        unavailable={unavailable}
        hint={hint}
        reload={reload}
      />
    );
  }
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
function catalogHint(supported: boolean, hasAgent: boolean, failed: boolean, loaded: boolean) {
  if (!supported) return "settings.voice.updateHost";
  if (!hasAgent) return "voiceCall.catalogNeedsConversation";
  if (failed) return "voiceCall.catalogFailed";
  return loaded ? "voiceCall.nativeHint" : "voiceCall.catalogLoading";
}
function VoiceOption({
  value,
  selected,
  setVoice,
}: {
  value: string;
  selected: boolean;
  setVoice: (value: string) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => setVoice(value), [setVoice, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select}>
      {value || t("voiceCall.providerDefault")}
    </DropdownMenuItem>
  );
}
function InlineVoicePicker({
  voice,
  currentVoice,
  setVoice,
  disabled,
  voices,
  available,
  failed,
  unavailable,
  hint,
  reload,
}: {
  voice: string;
  currentVoice?: string;
  setVoice: (value: string) => void;
  disabled: boolean;
  voices: string[];
  available: boolean;
  failed: boolean;
  unavailable: boolean;
  hint: string;
  reload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        accessibilityLabel={t("voiceCall.changeVoice")}
        testID="voice-call-change-voice"
        style={styles.trigger}
      >
        <Text style={styles.hint}>
          {voice === (currentVoice ?? "")
            ? voice || t("voiceCall.providerDefault")
            : t("voiceCall.nextVoiceSelection", { voice: voice || t("voiceCall.providerDefault") })}
        </Text>
        <ThemedChevronDown size={14} uniProps={chevronColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" width={280} maxHeight={360} scrollable>
        <DropdownMenuHint>{t("voiceCall.nextCallVoiceHint")}</DropdownMenuHint>
        {!available ? <DropdownMenuHint>{hint}</DropdownMenuHint> : null}
        {unavailable ? (
          <DropdownMenuHint>{t("voiceCall.chooseSupportedVoice", { voice })}</DropdownMenuHint>
        ) : null}
        {available
          ? ["", ...voices].map((value) => (
              <VoiceOption
                key={value || "default"}
                value={value}
                selected={voice === value}
                setVoice={setVoice}
              />
            ))
          : null}
        {failed ? (
          <DropdownMenuItem onSelect={reload}>{t("common.actions.retry")}</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
  },
  info: { padding: theme.spacing[3], gap: theme.spacing[2] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
