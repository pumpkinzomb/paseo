import { z } from "zod";
import type { NativeVoicePeerOptions } from "./native-voice-peer";

const Event = z.object({
  type: z.string(),
  item: z.object({ text: z.string() }).optional(),
  transcript: z.string().optional(),
  reason: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

export function handleNativeVoiceEvent(payload: unknown, callbacks: NativeVoicePeerOptions): void {
  const parsed = Event.safeParse(payload);
  if (!parsed.success) return;
  const event = parsed.data;
  switch (event.type) {
    case "input_audio_buffer.speech_started":
      callbacks.onSpeech(true);
      break;
    case "input_audio_buffer.speech_stopped":
    case "turn.created":
      callbacks.onSpeech(false);
      break;
    case "input_transcript.added":
      if (event.item) callbacks.onTranscript(event.item.text);
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (event.transcript) callbacks.onTranscript(event.transcript);
      break;
    case "output_transcript.added":
    case "output_audio_buffer.started":
      callbacks.onPlaying(true);
      break;
    case "turn.done":
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      callbacks.onPlaying(false);
      break;
    case "session.closed":
      callbacks.onEnded(new Error(`Native voice session ${event.reason ?? "closed"}`));
      break;
    case "error":
      callbacks.onEnded(new Error(event.error?.message ?? "Native voice failed"));
      break;
  }
}
