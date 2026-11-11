/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useWorkspaceRestoreRecovery,
  WORKSPACE_RESTORE_TIMEOUT_MS,
} from "./use-workspace-restore-recovery";

const runtime = vi.hoisted(() => ({ runProbeCycleNow: vi.fn(), refreshDirectories: vi.fn() }));
vi.mock("@/runtime/host-runtime", () => ({ getHostRuntimeStore: () => runtime }));
let result: ReturnType<typeof useWorkspaceRestoreRecovery>;
function Probe({ serverId }: { serverId: string | null }) {
  result = useWorkspaceRestoreRecovery(serverId);
  return null;
}
let root: Root | null = null;
function render(serverId: string | null) {
  root ??= createRoot(document.createElement("div"));
  act(() => root?.render(<Probe serverId={serverId} />));
}
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("saved-host startup recovery", () => {
  it("bounds the saved-host wait independently of another online host and retries only that host", async () => {
    vi.useFakeTimers();
    runtime.runProbeCycleNow.mockResolvedValue(undefined);
    runtime.refreshDirectories.mockResolvedValue(undefined);
    render("saved-host");
    act(() => vi.advanceTimersByTime(WORKSPACE_RESTORE_TIMEOUT_MS - 1));
    expect(result.needsRecovery).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.needsRecovery).toBe(true);
    await act(async () => result.retry());
    expect(result.needsRecovery).toBe(false);
    expect(runtime.runProbeCycleNow).toHaveBeenCalledExactlyOnceWith("saved-host");
    expect(runtime.refreshDirectories).toHaveBeenCalledExactlyOnceWith("saved-host");
    act(() => vi.advanceTimersByTime(WORKSPACE_RESTORE_TIMEOUT_MS));
    expect(result.needsRecovery).toBe(true);
  });

  it("shows recovery again when retry fails and cancels it once hydration finishes", async () => {
    vi.useFakeTimers();
    runtime.runProbeCycleNow.mockRejectedValue(new Error("offline"));
    render("saved-host");
    await act(async () => result.retry());
    expect(result.needsRecovery).toBe(true);
    expect(runtime.refreshDirectories).not.toHaveBeenCalled();
    render(null);
    act(() => vi.advanceTimersByTime(WORKSPACE_RESTORE_TIMEOUT_MS));
    expect(result.needsRecovery).toBe(false);
  });

  it("ignores late retry failure after navigation or successful hydration", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    runtime.runProbeCycleNow.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    render("saved-host");
    act(() => result.retry());
    render(null);
    await act(async () => reject(new Error("late")));
    expect(result.needsRecovery).toBe(false);
    expect(runtime.refreshDirectories).not.toHaveBeenCalled();
  });

  it("does not refresh a stale host after a late successful probe", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    runtime.runProbeCycleNow.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    render("saved-host");
    act(() => result.retry());
    render(null);
    await act(async () => resolve());
    expect(runtime.refreshDirectories).not.toHaveBeenCalled();
    expect(result.needsRecovery).toBe(false);
  });
});
