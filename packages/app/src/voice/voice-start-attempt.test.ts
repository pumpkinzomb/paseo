import { describe, expect, it, vi } from "vitest";
import { createVoiceStartAttempt } from "./voice-start-attempt";

describe("voice setup start lifecycle", () => {
  it("does not start after the preparation sheet is dismissed", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn();
    const attempt = createVoiceStartAttempt({ start, stop, isActive: () => false });
    attempt.cancel();
    expect(await attempt.start()).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
  it("starts only once when readiness updates repeatedly", async () => {
    let finish!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const attempt = createVoiceStartAttempt({ start, stop: vi.fn(), isActive: () => true });
    const first = attempt.start();
    expect(await attempt.start()).toBe(false);
    finish();
    expect(await first).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("stops its own voice session if microphone startup finishes after cancellation", async () => {
    let finish!: () => void;
    const start = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const stop = vi.fn().mockResolvedValue(undefined);
    const attempt = createVoiceStartAttempt({ start, stop, isActive: () => true });
    const pending = attempt.start();
    attempt.cancel();
    finish();
    expect(await pending).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("leaves a different active conversation alone after cancellation", async () => {
    let finish!: () => void;
    const stop = vi.fn();
    const attempt = createVoiceStartAttempt({
      start: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      stop,
      isActive: () => false,
    });
    const pending = attempt.start();
    attempt.cancel();
    finish();
    expect(await pending).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
  it("permits retry after startup fails", async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("Microphone denied"))
      .mockResolvedValue(undefined);
    const attempt = createVoiceStartAttempt({ start, stop: vi.fn(), isActive: () => false });
    await expect(attempt.start()).rejects.toThrow("Microphone denied");
    expect(await attempt.start()).toBe(true);
  });
});
