import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { i18n } from "@/i18n/i18next";

export class MicrophoneAccessDeniedError extends Error {
  override name = "NotAllowedError";
}

export async function ensureMicrophoneAccess(
  host: DesktopHostBridge | null = getDesktopHost(),
): Promise<void> {
  if (host?.platform !== "darwin") return;
  if (!host.microphone)
    throw new Error(i18n.t("desktop.permissions.microphone.nativeBridgeUnavailable"));
  const state = await host.microphone.requestAccess();
  if (state !== "granted")
    throw new MicrophoneAccessDeniedError(i18n.t("desktop.permissions.microphone.requestDenied"));
}
