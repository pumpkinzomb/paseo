import { useCallback, useMemo, useState } from "react";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { NativeCallSettings } from "@/voice/native-call-settings";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown, Mic, MicOff, PhoneOff } from "lucide-react-native";
import { useVoice, useVoiceTelemetry } from "@/contexts/voice-context";
import { Button } from "@/components/ui/button";
import { VolumeMeter } from "./volume-meter";

interface RealtimeVoiceOverlayProps {
  isMuted: boolean;
  isSwitching: boolean;
  onToggleMute: () => void;
  onStop: () => void;
}

export function RealtimeVoiceOverlay({
  isMuted,
  isSwitching,
  onToggleMute,
  onStop,
}: RealtimeVoiceOverlayProps) {
  const { t } = useTranslation();
  const { volume, isSpeaking } = useVoiceTelemetry();
  const voice = useVoice();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const settingsHeader = useMemo(() => ({ title: t("voiceCall.nativeTitle") }), [t]);
  const settingsFooter = useMemo(
    () => (
      <Button variant="secondary" onPress={closeSettings}>
        {t("voiceSetup.close")}
      </Button>
    ),
    [closeSettings, t],
  );
  let status = "listening";
  if (voice.phase === "starting") status = "connecting";
  else if (voice.phase === "stopping") status = "ending";
  else if (voice.phase === "playing") status = "speaking";
  else if (isMuted) status = "muted";
  else if (voice.phase === "waiting") status = "connected";
  return (
    <View style={styles.container} testID="voice-call-controls">
      <View style={styles.status}>
        {voice.voiceRoute === "native" ? (
          <View style={styles.voiceLabel}>
            <Text style={styles.text}>{t("voiceCall.routeNative")}</Text>
            <Button
              variant="ghost"
              leftIcon={ChevronDown}
              onPress={openSettings}
              disabled={
                isSwitching ||
                voice.phase === "stopping" ||
                !voice.activeServerId ||
                !voice.activeAgentId
              }
              accessibilityLabel={t("voiceCall.changeVoice")}
              testID="voice-call-change-voice"
            >
              {voice.effectiveVoice || t("voiceCall.providerDefault")}
            </Button>
          </View>
        ) : (
          <Text style={styles.text}>{t("voiceCall.routeSpeech")}</Text>
        )}
        <Text style={styles.text} accessibilityLiveRegion="polite">
          {t(`voiceCall.${status}`)}
        </Text>
        <VolumeMeter
          volume={volume}
          isMuted={isMuted}
          isSpeaking={isSpeaking}
          orientation="horizontal"
        />
      </View>
      {settingsOpen &&
      voice.voiceRoute === "native" &&
      voice.activeServerId &&
      voice.activeAgentId ? (
        <AdaptiveModalSheet
          visible
          header={settingsHeader}
          footer={settingsFooter}
          onClose={closeSettings}
        >
          <View style={styles.settings}>
            <Text style={styles.text}>{t("voiceCall.nextCallVoiceHint")}</Text>
            <NativeCallSettings serverId={voice.activeServerId} agentId={voice.activeAgentId} />
          </View>
        </AdaptiveModalSheet>
      ) : null}
      <Button
        variant="ghost"
        leftIcon={isMuted ? MicOff : Mic}
        onPress={onToggleMute}
        disabled={isSwitching}
        accessibilityLabel={
          isMuted ? t("realtimeVoice.actions.unmute") : t("realtimeVoice.actions.mute")
        }
      />
      <Button
        variant="outline"
        leftIcon={PhoneOff}
        onPress={onStop}
        loading={voice.phase === "stopping"}
        accessibilityLabel={t("voiceCall.end")}
      />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
  },
  voiceLabel: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  settings: { padding: theme.spacing[4], gap: theme.spacing[3] },
  status: { flex: 1, gap: theme.spacing[1] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
