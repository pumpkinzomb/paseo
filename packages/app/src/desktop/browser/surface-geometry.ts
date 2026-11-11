interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface GeometrySource {
  getBoundingClientRect(): Bounds;
}
interface FrameClock {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  readonly screenX: number;
  readonly screenY: number;
  readonly devicePixelRatio: number;
}

/** ResizeObserver misses translation and sibling-driven layout shifts. */
export function trackBrowserSurfaceGeometry(
  anchor: GeometrySource,
  clip: GeometrySource,
  update: () => void,
  clock: FrameClock = window,
): () => void {
  let previous: number[] | undefined;
  let frame = 0;
  let stopped = false;
  function check() {
    if (stopped) return;
    const a = anchor.getBoundingClientRect();
    const c = clip.getBoundingClientRect();
    const next = [
      a.left,
      a.top,
      a.width,
      a.height,
      c.left,
      c.top,
      c.width,
      c.height,
      clock.screenX,
      clock.screenY,
      clock.devicePixelRatio,
    ];
    if (!previous || next.some((value, index) => value !== previous?.[index])) {
      previous = next;
      update();
    }
    if (!stopped) frame = clock.requestAnimationFrame(check);
  }
  frame = clock.requestAnimationFrame(check);
  return () => {
    stopped = true;
    clock.cancelAnimationFrame(frame);
  };
}
