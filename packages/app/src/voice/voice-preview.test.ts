import { expect, it, vi } from "vitest";
import { apiVoiceSample, createVoicePreview } from "./voice-preview";

it("limits official API samples to the selected official route and known voices", () => {
  expect(apiVoiceSample("coral", "")).toBe("https://cdn.openai.com/API/docs/audio/coral.wav");
  expect(apiVoiceSample("coral", "https://custom.example/v1")).toBeNull();
  expect(apiVoiceSample("custom", "")).toBeNull();
});

it("ignores late fetch completion after stop, selection change or unmount", async () => {
  let finish!: (source: Blob) => void;
  const onState = vi.fn();
  const player = { play: vi.fn().mockResolvedValue(1) };
  const preview = createVoicePreview({
    onState,
    player,
    fetchAudio: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const playing = preview.play("sample");
  expect(onState).toHaveBeenLastCalledWith("loading");
  preview.stop();
  finish(new Blob(["audio"], { type: "audio/wav" }));
  await playing;
  expect(player.play).not.toHaveBeenCalled();
  expect(onState).toHaveBeenLastCalledWith("idle");
});

it("publishes playback and errors, and aborts old playback when switched", async () => {
  const onState = vi.fn();
  let playbackSignal: AbortSignal | undefined;
  const player = {
    play: vi.fn(async (_source, signal) => {
      playbackSignal = signal;
      throw new Error("decoder");
    }),
  };
  const preview = createVoicePreview({
    onState,
    player,
    fetchAudio: async () => new Blob(["audio"]),
  });
  await preview.play("a");
  expect(onState.mock.calls.map(([state]) => state)).toEqual([
    "idle",
    "loading",
    "playing",
    "failed",
  ]);
  player.play.mockImplementation(async (_source, signal) => {
    playbackSignal = signal;
    return new Promise(() => {});
  });
  void preview.play("b");
  await Promise.resolve();
  preview.stop();
  expect(playbackSignal?.aborted).toBe(true);
});
