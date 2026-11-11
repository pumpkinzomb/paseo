export type NativeVoiceEvent =
  | { type: "transcript"; role: string; text: string }
  | { type: "error"; message: string }
  | { type: "closed"; reason: string | null };

export interface NativeVoiceConnection {
  answerSdp: string;
  stop(): Promise<void>;
}
