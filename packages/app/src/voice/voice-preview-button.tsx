import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateTransientBlocker } from "@/desktop/dev-update/transient-state";
import { SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { createAudioEngine } from "@/audio";
import { useVoiceOptional } from "@/contexts/voice-context";
import { apiVoiceSample, createVoicePreview, type PreviewState } from "./voice-preview";

export function VoicePreviewButton({ voice, baseUrl }: { voice: string; baseUrl: string }) {
  const { t } = useTranslation();
  const call = useVoiceOptional();
  const [state, setState] = useState<PreviewState>("idle");
  const player = useMemo(() => createAudioEngine({ onCaptureData() {}, onVolumeLevel() {} }), []);
  const preview = useMemo(
    () =>
      createVoicePreview({
        onState: setState,
        player,
        fetchAudio: async (url, signal) => {
          const response = await fetch(url, { signal, credentials: "omit" });
          if (!response.ok) throw new Error("Preview unavailable");
          return response.blob();
        },
      }),
    [player],
  );
  useEffect(
    () => () => {
      preview.stop();
    },
    [preview, voice, baseUrl, call?.isVoiceMode],
  );
  useEffect(
    () => () => {
      void player.destroy();
    },
    [player],
  );
  const url = apiVoiceSample(voice, baseUrl);
  const busy = state === "loading" || state === "playing";
  useUpdateTransientBlocker("voice-preview", busy);
  let hint = t("voiceCall.apiPreviewHint") + ` ${t("voiceCall.toneHint")}`;
  if (!url) hint = t("voiceCall.previewUnavailable");
  else if (state === "failed") hint = t("voiceCall.previewFailed");
  let label = t("voiceCall.preview");
  if (state === "loading") label = t("voiceCall.cancelPreview");
  else if (state === "playing") label = t("voiceCall.stopPreview");
  const press = useCallback(() => {
    if (busy) preview.stop();
    else if (url) void preview.play(url);
  }, [busy, preview, url]);
  return (
    <SettingsRow label={t("voiceCall.apiPreview")} hint={hint}>
      <Button
        variant="outline"
        disabled={!url || Boolean(call?.activeServerId)}
        onPress={press}
        accessibilityLabel={label}
      >
        {label}
      </Button>
    </SettingsRow>
  );
}
