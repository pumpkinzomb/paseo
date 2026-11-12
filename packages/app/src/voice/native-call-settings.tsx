import { useHostFeature } from "@/runtime/host-features";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { apiVoiceTone } from "./voice-preview";
import { VoicePreviewButton } from "./voice-preview-button";
import { useNativeVoicePreference } from "./native-voice-preference";

// These IDs exist in the installed Codex RealtimeVoice schema. The server checks
// the account's V3 list on each explicit choice; schema membership is not availability.
const VOICES = ["coral", "ash", "alloy", "sage", "shimmer", "marin", "cedar"];
export function NativeCallSettings({ serverId }: { serverId: string }) {
  const supported = useHostFeature(serverId, "nativeVoiceCalls");
  const { t } = useTranslation();
  const voice = useNativeVoicePreference((s) => s.voice);
  const setVoice = useNativeVoicePreference((s) => s.setVoice);
  return (
    <SettingsSection title={t("voiceCall.nativeTitle")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.voice.voice")}
          hint={supported ? t("voiceCall.nativeHint") : t("settings.voice.updateHost")}
          disabled={!supported}
          value={voice}
          options={[
            { value: "", label: t("voiceCall.providerDefault") },
            ...VOICES.map((value) => ({
              value,
              label: `${value} · ${apiVoiceTone(value) ? t("voiceCall.referenceTone", { tone: t(`voiceCall.${apiVoiceTone(value)}`) }) : t("voiceCall.toneUnverified")}`,
            })),
          ]}
          onValueChange={setVoice}
        />
        <VoicePreviewButton voice={voice} baseUrl="" nativeReference disabled={!supported} />
      </SettingsCard>
    </SettingsSection>
  );
}
