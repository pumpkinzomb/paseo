import { ensureMicrophoneAccess } from "@/desktop/permissions/microphone-access";
import type { NativeVoicePeer, NativeVoicePeerOptions } from "./native-voice-peer";
import { handleNativeVoiceEvent } from "./native-voice-events";
export function nativeVoicePeerAvailable(): boolean {
  return (
    typeof RTCPeerConnection !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}
/** Audio stays in WebRTC media tracks; SDP alone travels through the authenticated daemon. */
export async function startNativeVoicePeer(
  options: NativeVoicePeerOptions,
): Promise<NativeVoicePeer> {
  if (!nativeVoicePeerAvailable()) throw new Error("Native voice needs WebRTC on this device");
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel("oai-events");
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.setAttribute("playsinline", "");
  let media: MediaStream | null = null;
  let stopped = false;
  let remoteAccepted = false;
  let remoteStop: Promise<unknown> | null = null;
  let muted = false;
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    media?.getTracks().forEach((track) => track.stop());
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    channel.close();
    peer.close();
  };
  const stop = async () => {
    cleanup();
    if (remoteAccepted) {
      remoteAccepted = false;
      remoteStop = options.stopRemote();
    }
    await remoteStop;
  };
  const abort = () => {
    void stop().catch(() => undefined);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const checkCancelled = () => {
    if (stopped || options.signal.aborted) throw new Error("Native voice startup cancelled");
  };
  peer.ontrack = (event) => {
    if (stopped) return;
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void audio
      .play()
      .catch((error: unknown) =>
        options.onEnded(error instanceof Error ? error : new Error(String(error))),
      );
  };
  channel.addEventListener("message", (event) => {
    if (stopped || typeof event.data !== "string") return;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    handleNativeVoiceEvent(data, options);
  });
  try {
    checkCancelled();
    await ensureMicrophoneAccess();
    checkCancelled();
    media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (stopped || options.signal.aborted) {
      media.getTracks().forEach((track) => track.stop());
      throw new Error("Native voice startup cancelled");
    }
    media.getTracks().forEach((track) => peer.addTrack(track, media!));
    await peer.setLocalDescription(await peer.createOffer());
    checkCancelled();
    const offer = peer.localDescription?.sdp;
    if (!offer) throw new Error("Could not create native voice offer");
    const answer = await options.negotiate(offer);
    remoteAccepted = true;
    checkCancelled();
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
    checkCancelled();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Native voice connection timed out")), 20000);
      const cancelled = () => finish(new Error("Native voice startup cancelled"));
      function finish(error?: Error) {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", cancelled);
        peer.removeEventListener("connectionstatechange", changed);
        if (error) reject(error);
        else resolve();
      }
      function changed() {
        if (peer.connectionState === "connected") finish();
        else if (peer.connectionState === "failed" || peer.connectionState === "closed")
          finish(new Error("Native voice connection failed"));
      }
      options.signal.addEventListener("abort", cancelled, { once: true });
      peer.addEventListener("connectionstatechange", changed);
      if (options.signal.aborted) cancelled();
      else changed();
    });
    peer.onconnectionstatechange = () => {
      if (!stopped && (peer.connectionState === "failed" || peer.connectionState === "closed"))
        options.onEnded(new Error("Native voice disconnected"));
    };
    return {
      stop: async () => {
        options.signal.removeEventListener("abort", abort);
        await stop();
      },
      toggleMute() {
        muted = !muted;
        media?.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
        });
        return muted;
      },
    };
  } catch (error) {
    options.signal.removeEventListener("abort", abort);
    await stop().catch(() => undefined);
    throw error;
  }
}
