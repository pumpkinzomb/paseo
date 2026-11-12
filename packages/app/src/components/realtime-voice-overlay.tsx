import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Mic, MicOff, PhoneOff } from "lucide-react-native";
import { useVoice, useVoiceTelemetry } from "@/contexts/voice-context";
import { Button } from "@/components/ui/button";
import { CallTranscript } from "@/voice/call-transcript";
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
  let status = "listening";
  if (voice.phase === "starting") status = "connecting";
  else if (voice.phase === "stopping") status = "ending";
  else if (voice.phase === "playing") status = "speaking";
  else if (isMuted) status = "muted";
  else if (voice.phase === "waiting") status = "connected";
  return (
    <View style={styles.container} testID="voice-call-controls">
      <View style={styles.status}>
        <Text style={styles.text}>
          {voice.voiceRoute === "native"
            ? `${t("voiceCall.routeNative")} · ${voice.effectiveVoice || t("voiceCall.providerDefault")}`
            : t("voiceCall.routeSpeech")}
        </Text>
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
      {voice.activeServerId && voice.activeAgentId ? (
        <CallTranscript serverId={voice.activeServerId} agentId={voice.activeAgentId} />
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
  status: { flex: 1, gap: theme.spacing[1] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
