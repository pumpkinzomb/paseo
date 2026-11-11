import { describe, expect, it } from "vitest";
import { shouldUseNativeVoice } from "./native-voice-routing";

describe("native voice routing", () => {
  it("resumes stored Codex sessions without requiring local STT/TTS setup", () => {
    expect(
      shouldUseNativeVoice({ provider: "codex", capabilities: {} }, true)
    ).toBe(true);
  });
  it("uses explicitly advertised native support for any provider", () => {
    expect(
      shouldUseNativeVoice(
        { provider: "other", capabilities: { supportsNativeVoice: true } },
        true
      )
    ).toBe(true);
  });
  it("honors explicit unsupported and non-Codex local voice", () => {
    expect(
      shouldUseNativeVoice(
        { provider: "codex", capabilities: { supportsNativeVoice: false } },
        true
      )
    ).toBe(false);
    expect(
      shouldUseNativeVoice({ provider: "claude", capabilities: {} }, true)
    ).toBe(false);
  });
  it("does not route absent agents or unsupported platforms to WebRTC", () => {
    expect(shouldUseNativeVoice(undefined, true)).toBe(false);
    expect(
      shouldUseNativeVoice(
        { provider: "codex", capabilities: { supportsNativeVoice: true } },
        false
      )
    ).toBe(false);
  });
});
