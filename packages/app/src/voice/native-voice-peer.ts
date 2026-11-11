export interface NativeVoicePeer {
  stop(): Promise<void>;
  toggleMute(): boolean;
}
export interface NativeVoicePeerOptions {
  signal: AbortSignal;
  negotiate: (offerSdp: string) => Promise<string>;
  stopRemote: () => Promise<unknown>;
  onSpeech: (speaking: boolean) => void;
  onTranscript: (text: string) => void;
  onPlaying: (playing: boolean) => void;
  onEnded: (error: Error) => void;
}

export function nativeVoicePeerAvailable(): boolean {
  return false;
}
export async function startNativeVoicePeer(
  _options: NativeVoicePeerOptions,
): Promise<NativeVoicePeer> {
  throw new Error("Native voice needs WebRTC on this device");
}
