import { safeBlockers, safeReceipt } from "./receipt.js";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { updateActivity } from "./activity.js";
import { browserUpdateBlockers } from "./browser-guard.js";

export interface OpenUpdateRequest {
  schemaVersion: 2;
  generation: string;
  requestId: string;
  releaseDigest: string;
  phase: "prepare" | "commit" | "abort";
  mode: "renderer" | "full";
  activityEpoch?: number;
  prepareToken?: string;
}
export function createOpenWindowUpdate() {
  let current: OpenUpdateRequest | undefined;
  let prepared: { token: string; epoch: number } | undefined;
  let cancelled = false;
  let commitSealed = false;
  let status: Record<string, unknown> = { state: "idle" };
  const pending = new Map<
    string,
    {
      sender: number;
      epoch: number;
      requireSeal: boolean;
      resolve: (value: { blockers: string[]; receipt?: unknown }) => void;
    }
  >();
  function publish(value: Record<string, unknown>) {
    status = value;
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send("paseo:dev-update:status", value);
  }
  function abort(reason: string) {
    // Keep the event that invalidated the checkpoint; its completion and cleanup
    // can emit more activity but must not replace the first cause.
    if (cancelled) return;
    cancelled = true;
    commitSealed = false;
    prepared = undefined;
    updateActivity.release();
    publish({ state: "blocked", blockers: safeBlockers(reason.split(",")) });
  }
  updateActivity.onActivity = (reason) => {
    if (current) abort(reason);
  };
  ipcMain.on("paseo:dev-update:activity", (event, reason: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender))
      updateActivity.activity(
        typeof reason === "string" ? reason.slice(0, 100) : "renderer-activity",
      );
  });
  ipcMain.handle("paseo:dev-update:cancel", (event) => {
    if (BrowserWindow.fromWebContents(event.sender)) abort("cancelled");
  });
  ipcMain.on("paseo:dev-update:cancel", (event) => {
    if (BrowserWindow.fromWebContents(event.sender)) abort("cancelled");
  });
  ipcMain.on("paseo:dev-update:receipt", (event, id: string, value: unknown) => {
    const waiter = pending.get(id);
    if (!waiter || waiter.sender !== event.sender.id) return;
    const result = value as { blockers?: unknown; receipt?: unknown } | null;
    if (
      !result ||
      !Array.isArray(result.blockers) ||
      !result.blockers.every((v) => typeof v === "string")
    )
      return;
    const receipt = safeReceipt(result.receipt, waiter.epoch, waiter.requireSeal);
    pending.delete(id);
    waiter.resolve({
      blockers: [
        ...safeBlockers(result.blockers),
        ...(!receipt && !result.blockers.length ? ["invalid-checkpoint-receipt"] : []),
      ],
      receipt,
    });
  });
  async function checkpoint(request: OpenUpdateRequest, epoch: number) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length !== 1 || !windows[0]!.isFocused() || windows[0]!.isMinimized())
      return { blockers: ["unsupported-window-state"], receipts: [] };
    const receipts = await Promise.all(
      BrowserWindow.getAllWindows().map(
        (window) =>
          new Promise<{ blockers: string[]; receipt?: unknown }>((resolve) => {
            const id = randomUUID();
            let settled = false;
            const finish = (value: { blockers: string[]; receipt?: unknown }) => {
              if (settled) return;
              settled = true;
              resolve(value);
            };
            const timer = setTimeout(() => {
              pending.delete(id);
              finish({ blockers: ["renderer-checkpoint-timeout"] });
            }, 10000);
            pending.set(id, {
              sender: window.webContents.id,
              epoch,
              requireSeal: request.phase === "commit",
              resolve: (value) => {
                clearTimeout(timer);
                finish(value);
              },
            });
            window.webContents.send("paseo:dev-update:prepare", {
              ...request,
              activityEpoch: epoch,
              checkpointId: id,
            });
          }),
      ),
    );
    return {
      blockers: [...browserUpdateBlockers(), ...receipts.flatMap((r) => r.blockers)],
      receipts: receipts.map((r) => r.receipt),
    };
  }
  const blockerReason = (blockers: string[]) => blockers.join(",") || "activity-changed";
  function matchesPrepared(request: OpenUpdateRequest): boolean {
    return Boolean(
      current &&
      prepared &&
      !cancelled &&
      request.requestId === current.requestId &&
      request.releaseDigest === current.releaseDigest &&
      request.generation === current.generation &&
      request.mode === current.mode &&
      request.prepareToken === prepared.token &&
      request.activityEpoch === prepared.epoch &&
      updateActivity.epoch === prepared.epoch,
    );
  }
  return {
    abort,
    status: () => status,
    observeHost(contents: WebContents): void {
      const onInput = (event: Electron.Event) => {
        // Native delivery barrier precedes renderer dispatch; terminal checkpoint
        // cannot acknowledge a keystroke that is still queued in another process.
        if (commitSealed) event.preventDefault();
        updateActivity.activity("trusted-input");
      };
      contents.on("before-input-event", onInput);
      contents.on("before-mouse-event", (event, mouse) => {
        if (mouse.type !== "mouseMove") onInput(event);
      });
    },
    async handle(request: OpenUpdateRequest): Promise<Record<string, unknown>> {
      if (request.phase === "abort") {
        abort("controller-aborted");
        current = undefined;
        return status;
      }
      if (request.phase === "commit") {
        if (!matchesPrepared(request) || !prepared)
          return { state: "blocked", blockers: ["stale-prepare"] };
        commitSealed = true;
        const check = await checkpoint(request, prepared.epoch);
        if (
          cancelled ||
          updateActivity.epoch !== prepared.epoch ||
          check.blockers.length ||
          updateActivity.inFlight
        ) {
          abort("commit-checkpoint-invalidated");
          return status;
        }
        return {
          state: "ready",
          prepareToken: prepared.token,
          activityEpoch: prepared.epoch,
          receipts: check.receipts,
        };
      }
      if (current?.requestId === request.requestId) return status;
      current = request;
      prepared = undefined;
      cancelled = false;
      const epoch = updateActivity.epoch;
      if (!updateActivity.seal()) {
        abort("native-operation-in-flight");
        return status;
      }
      const first = await checkpoint(request, epoch);
      if (cancelled || first.blockers.length) {
        abort(blockerReason(first.blockers));
        return status;
      }
      for (let seconds = 5; seconds > 0; seconds--) {
        if (cancelled) return status;
        publish({
          state: "countdown",
          countdownSeconds: seconds,
          blockers: [],
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const final = await checkpoint(request, epoch);
      if (cancelled || updateActivity.epoch !== epoch || final.blockers.length) {
        abort(blockerReason(final.blockers));
        return status;
      }
      prepared = { token: randomUUID(), epoch };
      publish({
        state: "prepared",
        prepareToken: prepared.token,
        activityEpoch: epoch,
        receipts: final.receipts,
      });
      // A controller disappearing must not leave browser automation permanently frozen.
      const token = prepared.token;
      setTimeout(() => {
        if (prepared?.token === token) abort("prepare-expired");
      }, 30000).unref();
      return status;
    },
  };
}
