import { shouldUseNativeVoice } from "@/voice/native-voice-routing";
import { useUpdateTransientBlocker } from "@/desktop/dev-update/transient-state";
import { nativeVoicePeerAvailable } from "./native-voice-peer";
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { HostVoicePage } from "@/screens/settings/voice/voice-page";
import { getVoiceReadinessState } from "@/utils/server-info-capabilities";
import type { VoiceRuntime } from "./voice-runtime";
import { createVoiceStartAttempt } from "./voice-start-attempt";

export const VoiceStartContext = createContext<VoiceRuntime["startVoice"] | null>(null);
interface Target {
  serverId: string;
  agentId: string;
}

export function VoiceEntryProvider({
  runtime,
  children,
}: {
  runtime: VoiceRuntime;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const close = useCallback(() => setTarget(null), []);
  const startVoice = useCallback(
    async (serverId: string, agentId: string) => {
      const session = useSessionStore.getState().getSession(serverId);
      const agent = session?.agentDetails.get(agentId) ?? session?.agents.get(agentId);
      if (shouldUseNativeVoice(agent, nativeVoicePeerAvailable())) {
        await runtime.startVoice(serverId, agentId);
        return;
      }
      const serverInfo = session?.serverInfo;
      const readiness = getVoiceReadinessState({ serverInfo, mode: "voice" });
      if (readiness && (!readiness.enabled || readiness.reason.trim())) {
        setTarget({ serverId, agentId });
        return;
      }
      await runtime.startVoice(serverId, agentId);
    },
    [runtime],
  );
  return (
    <VoiceStartContext value={startVoice}>
      {children}
      {target ? (
        <VoiceSetupSheet
          key={`${target.serverId}:${target.agentId}`}
          target={target}
          runtime={runtime}
          onClose={close}
        />
      ) : null}
    </VoiceStartContext>
  );
}

function VoiceSetupSheet({
  target,
  runtime,
  onClose,
}: {
  target: Target;
  runtime: VoiceRuntime;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { serverId, agentId } = target;
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "speechSettings");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [wanted, setWanted] = useState(false);
  const [busy, setBusy] = useState(false);
  useUpdateTransientBlocker("voice-setup-pending", busy || wanted);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const saving = useRef(false);
  const attemptRef = useRef<ReturnType<typeof createVoiceStartAttempt> | null>(null);
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
      if (attemptRef.current === attempt) attemptRef.current = null;
    };
  }, [runtime, serverId, agentId]);
  const readiness = getVoiceReadinessState({ serverInfo, mode: "voice" });
  const ready = Boolean(readiness?.enabled && !readiness.reason.trim());
  const enabled = config?.features?.voiceMode.enabled === true;
  const begin = useCallback(async () => {
    if (saving.current || wanted || !connected || !supported || !config?.features) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!config.features.voiceMode.enabled) {
        const saved = await patchConfig({ features: { voiceMode: { enabled: true } } });
        if (!saved?.features?.voiceMode.enabled) throw new Error(t("voiceSetup.enableFailed"));
      }
      if (mounted.current) setWanted(true);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [wanted, connected, supported, config, patchConfig, t]);
  const beginPress = useCallback(() => {
    void begin();
  }, [begin]);
  useEffect(() => {
    if (!wanted || !connected || !ready) return;
    const attempt = attemptRef.current;
    if (!attempt) return;
    void attempt
      .start()
      .then((started) => {
        if (started && mounted.current) onClose();
        return started;
      })
      .catch((failure: unknown) => {
        if (!mounted.current) return;
        setWanted(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      });
  }, [wanted, connected, ready, onClose]);
  const header = useMemo(() => ({ title: t("voiceSetup.title") }), [t]);
  let startLabel = t("voiceSetup.enableAndStart");
  if (enabled) startLabel = t("voiceSetup.start");
  if (wanted) startLabel = t("voiceSetup.waiting");
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={onClose}>
          {t("voiceSetup.close")}
        </Button>
        <Button
          onPress={beginPress}
          loading={busy}
          disabled={busy || wanted || !connected || !supported || !config?.features}
          testID="voice-setup-start"
        >
          {startLabel}
        </Button>
      </View>
    ),
    [onClose, beginPress, busy, wanted, connected, supported, config, startLabel, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      footer={footer}
      onClose={onClose}
      testID="voice-setup-sheet"
    >
      <View style={styles.content}>
        <Text style={styles.text}>{t("voiceSetup.description")}</Text>
        <Text style={styles.text}>{t("voiceSetup.languages")}</Text>
        {wanted ? <Text style={styles.text}>{t("voiceSetup.preparing")}</Text> : null}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {enabled && !ready && readiness?.reason ? (
          <Text style={styles.text}>{readiness.reason}</Text>
        ) : null}
        <HostVoicePage serverId={serverId} voiceOnly />
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foregroundMuted, fontSize: 13 },
  error: { color: theme.colors.destructive, fontSize: 13 },
}));
