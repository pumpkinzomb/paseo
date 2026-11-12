import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useUpdateTransientBlocker } from "@/desktop/dev-update/transient-state";
import { NativeCallSettings } from "./native-call-settings";
import { createVoiceStartAttempt } from "./voice-start-attempt";
import type { VoiceRuntime } from "./voice-runtime";

export function NativeVoiceRecovery({
  serverId,
  agentId,
  runtime,
  onClose,
}: {
  serverId: string;
  agentId: string;
  runtime: VoiceRuntime;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef<ReturnType<typeof createVoiceStartAttempt> | null>(null);
  const mounted = useRef(false);
  useUpdateTransientBlocker("native-voice-recovery", busy);
  useEffect(() => {
    mounted.current = true;
    const attempt = createVoiceStartAttempt({
      start: () => runtime.startVoice(serverId, agentId),
      stop: () => runtime.stopVoice(),
      isActive: () => runtime.isVoiceModeForAgent(serverId, agentId),
    });
    attemptRef.current = attempt;
    return () => {
      mounted.current = false;
      attempt.cancel();
      attemptRef.current = null;
    };
  }, [runtime, serverId, agentId]);
  const retry = useCallback(() => {
    if (!ready || busy || !attemptRef.current) return;
    setBusy(true);
    setError(null);
    void attemptRef.current
      .start()
      .then((started) => {
        if (started && mounted.current) onClose();
        return started;
      })
      .catch((failure: unknown) => {
        if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  }, [ready, busy, onClose]);
  const header = useMemo(() => ({ title: t("voiceCall.nativeTitle") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={onClose}>
          {t("voiceSetup.close")}
        </Button>
        <Button
          onPress={retry}
          disabled={!ready || busy}
          loading={busy}
          testID="native-voice-retry"
        >
          {t("common.actions.retry")}
        </Button>
      </View>
    ),
    [onClose, retry, ready, busy, t],
  );
  return (
    <AdaptiveModalSheet visible header={header} footer={footer} onClose={onClose}>
      <View style={styles.content}>
        <Text style={styles.hint}>{t("voiceCall.nativeRecovery")}</Text>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <NativeCallSettings serverId={serverId} agentId={agentId} onReady={setReady} />
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
