import { describe, expect, it, vi } from "vitest";
import { handleNativeVoiceEvent } from "./native-voice-events";

function setup() {
  return {
    signal: new AbortController().signal,
    negotiate: vi.fn(),
    stopRemote: vi.fn(),
    onSpeech: vi.fn(),
    onTranscript: vi.fn(),
    onPlaying: vi.fn(),
    onEnded: vi.fn(),
  };
}
describe("native realtime events", () => {
  it("handles the V3 transcript and turn events observed on the real connection", () => {
    const callbacks = setup();
    handleNativeVoiceEvent(
      {
        type: "input_transcript.added",
        item: { id: "input", type: "input_transcript", text: "Hello" },
        start_ms: 100,
        end_ms: 200,
      },
      callbacks,
    );
    handleNativeVoiceEvent({ type: "turn.created" }, callbacks);
    handleNativeVoiceEvent(
      { type: "output_transcript.added", item: { text: "Hello back" } },
      callbacks,
    );
    expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith("Hello");
    expect(callbacks.onSpeech).toHaveBeenCalledExactlyOnceWith(false);
    expect(callbacks.onPlaying).toHaveBeenCalledExactlyOnceWith(true);
    handleNativeVoiceEvent({ type: "turn.done" }, callbacks);
    expect(callbacks.onPlaying).toHaveBeenLastCalledWith(false);
  });
  it("reports expiration and backend errors", () => {
    const callbacks = setup();
    handleNativeVoiceEvent({ type: "session.closed", reason: "expired" }, callbacks);
    expect(callbacks.onEnded).toHaveBeenLastCalledWith(new Error("Native voice session expired"));
    handleNativeVoiceEvent({ type: "error", error: { message: "unavailable" } }, callbacks);
    expect(callbacks.onEnded).toHaveBeenLastCalledWith(new Error("unavailable"));
  });
  it("ignores malformed network messages", () => {
    const callbacks = setup();
    handleNativeVoiceEvent(null, callbacks);
    handleNativeVoiceEvent({ type: "input_transcript.added", item: { text: 42 } }, callbacks);
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    expect(callbacks.onEnded).not.toHaveBeenCalled();
  });
});
