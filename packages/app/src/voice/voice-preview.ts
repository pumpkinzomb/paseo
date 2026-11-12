export type PreviewState = "idle" | "loading" | "playing" | "failed";
export interface PreviewPlayback {
  play(
    source: { arrayBuffer(): Promise<ArrayBuffer>; size: number; type: string },
    signal: AbortSignal,
  ): Promise<number>;
}

/** A single owner for fetch/playback; stale completions cannot change current UI. */
export function createVoicePreview(deps: {
  fetchAudio: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number; type: string }>;
  player: PreviewPlayback;
  onState: (state: PreviewState) => void;
}) {
  let active: AbortController | null = null;
  function stop() {
    active?.abort();
    active = null;
    deps.onState("idle");
  }
  return {
    stop,
    async play(url: string) {
      stop();
      const controller = new AbortController();
      active = controller;
      deps.onState("loading");
      const timeout = setTimeout(() => {
        if (active !== controller) return;
        active = null;
        controller.abort();
        deps.onState("failed");
      }, 30000);
      controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
      try {
        const source = await deps.fetchAudio(url, controller.signal);
        if (controller.signal.aborted) return;
        deps.onState("playing");
        await deps.player.play(source, controller.signal);
        if (active === controller) {
          active = null;
          deps.onState("idle");
        }
      } catch {
        if (active === controller && !controller.signal.aborted) {
          active = null;
          deps.onState("failed");
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

const SAMPLE_VOICES = new Set([
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
]);
export function apiVoiceSample(voice: string, baseUrl: string): string | null {
  // Official API references are not samples for custom endpoints or Codex calls.
  if (baseUrl && baseUrl.replace(/\/$/, "") !== "https://api.openai.com/v1") return null;
  return SAMPLE_VOICES.has(voice) ? `https://cdn.openai.com/API/docs/audio/${voice}.wav` : null;
}
