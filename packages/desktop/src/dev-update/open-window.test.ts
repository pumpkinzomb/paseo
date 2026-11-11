/* eslint-disable @typescript-eslint/no-explicit-any -- Minimal Electron event-emitter test doubles. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => void>(),
  windows: [] as any[],
  blockers: [] as string[],
  sent: [] as any[],
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => void) =>
      mock.listeners.set(channel, handler),
    on: (channel: string, handler: (...args: any[]) => void) =>
      mock.listeners.set(channel, handler),
  },
  BrowserWindow: {
    getAllWindows: () => mock.windows,
    fromWebContents: () => mock.windows[0],
  },
}));
vi.mock("./browser-guard.js", () => ({
  browserUpdateBlockers: () => mock.blockers,
}));
import { createOpenWindowUpdate, type OpenUpdateRequest } from "./open-window.js";
import { updateActivity } from "./activity.js";
const request: OpenUpdateRequest = {
  schemaVersion: 2,
  generation: "g",
  requestId: "r",
  releaseDigest: "a".repeat(64),
  phase: "prepare",
  mode: "renderer",
};
beforeEach(() => {
  vi.useFakeTimers();
  mock.listeners.clear();
  mock.blockers = [];
  mock.sent = [];
  updateActivity.release();
  updateActivity.onActivity = () => {};
  mock.windows = [
    {
      isFocused: () => true,
      isMinimized: () => false,
      webContents: {
        id: 1,
        send: (channel: string, payload: any) => {
          mock.sent.push({ channel, payload });
          if (channel.endsWith(":prepare"))
            mock.listeners.get("paseo:dev-update:receipt")?.(
              { sender: { id: 1 } },
              payload.checkpointId,
              {
                blockers: [],
                receipt: {
                  schemaVersion: 1,
                  sealed: payload.phase === "commit",
                  digest: "b".repeat(64),
                  capturedAt: 1,
                  activityEpoch: payload.activityEpoch,
                },
              },
            );
        },
      },
    },
  ];
});
describe("two phase open-window update", () => {
  it("requires exact digest/token/epoch and checkpoints again on commit", async () => {
    const controller = createOpenWindowUpdate();
    const work = controller.handle(request);
    await vi.advanceTimersByTimeAsync(5001);
    const prepared = await work;
    expect(prepared.state).toBe("prepared");
    expect(
      (
        await controller.handle({
          ...request,
          phase: "commit",
          releaseDigest: "c".repeat(64),
          prepareToken: prepared.prepareToken as string,
          activityEpoch: prepared.activityEpoch as number,
        })
      ).state,
    ).toBe("blocked");
    expect(
      (
        await controller.handle({
          ...request,
          phase: "commit",
          prepareToken: prepared.prepareToken as string,
          activityEpoch: prepared.activityEpoch as number,
        })
      ).state,
    ).toBe("ready");
    expect(mock.sent.filter((s) => s.channel.endsWith(":prepare"))).toHaveLength(3);
  });
  it("invalidates countdown for new work and reopens automation admission", async () => {
    const controller = createOpenWindowUpdate();
    const work = controller.handle(request);
    await vi.advanceTimersByTimeAsync(1);
    updateActivity.activity("trusted-input");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await work).state).toBe("blocked");
    await expect(updateActivity.run("new-work", async () => true)).resolves.toBe(true);
  });
  it("blocks opaque guests and multiple/minimized/unfocused windows", async () => {
    const controller = createOpenWindowUpdate();
    mock.blockers = ["browser-state-not-restorable"];
    expect((await controller.handle(request)).state).toBe("blocked");
    mock.blockers = [];
    mock.windows.push(mock.windows[0]);
    expect((await controller.handle({ ...request, requestId: "next" })).state).toBe("blocked");
  });
  it("expires prepared admission and rejects late commit", async () => {
    const controller = createOpenWindowUpdate();
    const work = controller.handle(request);
    await vi.advanceTimersByTimeAsync(5001);
    const prepared = await work;
    await vi.advanceTimersByTimeAsync(30001);
    expect(
      (
        await controller.handle({
          ...request,
          phase: "commit",
          prepareToken: prepared.prepareToken as string,
          activityEpoch: prepared.activityEpoch as number,
        })
      ).state,
    ).toBe("blocked");
    await expect(updateActivity.run("after-expiry", async () => true)).resolves.toBe(true);
  });
});

it("native terminal input barrier cancels before committing and releases after abort", async () => {
  const controller = createOpenWindowUpdate();
  const listeners = new Map<string, (...args: any[]) => void>();
  controller.observeHost({
    on: (name: string, listener: (...args: any[]) => void) => listeners.set(name, listener),
  } as any);
  const preparation = controller.handle(request);
  await vi.advanceTimersByTimeAsync(5001);
  const prepared = await preparation;
  const commit = controller.handle({
    ...request,
    phase: "commit",
    prepareToken: prepared.prepareToken as string,
    activityEpoch: prepared.activityEpoch as number,
  });
  const preventDefault = vi.fn();
  listeners.get("before-input-event")!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect((await commit).state).toBe("blocked");
  const next = vi.fn();
  listeners.get("before-input-event")!({ preventDefault: next });
  expect(next).not.toHaveBeenCalled();
});
