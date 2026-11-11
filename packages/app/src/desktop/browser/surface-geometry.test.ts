import { describe, expect, it, vi } from "vitest";
import { trackBrowserSurfaceGeometry } from "./surface-geometry";

describe("browser surface geometry tracking", () => {
  it("follows position-only shifts and window moves without updating unchanged frames", () => {
    let anchorBounds = { left: 400, top: 100, width: 500, height: 600 };
    let clipBounds = { ...anchorBounds };
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    const clock = {
      screenX: 0,
      screenY: 0,
      devicePixelRatio: 1,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++id, callback);
        return id;
      },
      cancelAnimationFrame: (frame: number) => {
        frames.delete(frame);
      },
    };
    function tick() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    }
    const update = vi.fn();
    const stop = trackBrowserSurfaceGeometry(
      { getBoundingClientRect: () => anchorBounds },
      { getBoundingClientRect: () => clipBounds },
      update,
      clock,
    );
    tick();
    expect(update).toHaveBeenCalledTimes(1);
    tick();
    expect(update).toHaveBeenCalledTimes(1);
    anchorBounds = { ...anchorBounds, left: 200 };
    clipBounds = { ...clipBounds, left: 200 };
    tick();
    expect(update).toHaveBeenCalledTimes(2);
    clipBounds = { ...clipBounds, top: 120 };
    tick();
    expect(update).toHaveBeenCalledTimes(3);
    clock.screenX = 80;
    tick();
    expect(update).toHaveBeenCalledTimes(4);
    clock.devicePixelRatio = 2;
    tick();
    expect(update).toHaveBeenCalledTimes(5);
    stop();
    expect(frames.size).toBe(0);
    tick();
    expect(update).toHaveBeenCalledTimes(5);
  });
});
