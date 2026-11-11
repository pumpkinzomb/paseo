import { ipcMain, webContents, type WebContents, type DownloadItem } from "electron";
import { updateActivity } from "./activity.js";

const guests = new Map<
  number,
  {
    contents: WebContents;
    frames: Map<number, number>;
    opaque: boolean;
    media: boolean;
    automationOpaque: boolean;
    downloads: number;
  }
>();
let installed = false;
let activeAutomation = 0;
const activeDownloads = new Set<DownloadItem>();
export function installBrowserUpdateGuard(): void {
  if (installed) return;
  installed = true;
  ipcMain.on("paseo:dev-update:guest", (event, kind: unknown) => {
    const guest = guests.get(event.sender.id);
    const frame = event.senderFrame;
    if (!guest || !frame) return;
    if (kind === "ready") guest.frames.set(frame.routingId, Date.now());
    else if (kind === "opaque") {
      guest.opaque = true;
      updateActivity.activity("browser-interaction");
    }
  });
}
export function observeBrowserForUpdate(contents: WebContents): void {
  if (guests.has(contents.id)) return;
  const state = {
    contents,
    frames: new Map<number, number>(),
    opaque: false,
    media: false,
    automationOpaque: activeAutomation > 0,
    downloads: 0,
  };
  guests.set(contents.id, state);
  updateActivity.activity("browser-created");
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    updateActivity.activity("browser-navigation");
    if (!inPlace && mainFrame) {
      state.frames.clear();
      state.opaque = false;
      state.automationOpaque = activeAutomation > 0;
      state.media = false;
    }
  });
  contents.on("will-prevent-unload", () => {
    state.opaque = true;
    updateActivity.activity("browser-unload-veto");
  });
  contents.on("media-started-playing", () => {
    state.media = true;
    updateActivity.activity("browser-media");
  });
  // Media/capture lifetimes cannot be exhaustively reconstructed; navigation resets the blocker.
  contents.session.on("will-download", (_event, item, source) => {
    if (source?.id === contents.id) {
      state.downloads += 1;
      activeDownloads.add(item);
      updateActivity.activity("browser-download");
      item.once("done", (_doneEvent, result) => {
        if (result === "completed" || result === "cancelled") {
          state.downloads -= 1;
          activeDownloads.delete(item);
        }
        updateActivity.activity("browser-download-finished");
      });
    }
  });
  contents.once("destroyed", () => {
    guests.delete(contents.id);
    updateActivity.activity("browser-closed");
  });
}
export function markBrowserAutomationOpaque(): void {
  for (const state of guests.values()) state.automationOpaque = true;
}
export function beginBrowserAutomation(): () => void {
  activeAutomation += 1;
  markBrowserAutomationOpaque();
  let finished = false;
  return () => {
    if (!finished) {
      finished = true;
      activeAutomation -= 1;
    }
  };
}
export function browserUpdateBlockers(): string[] {
  const blockers: string[] = [];
  if (activeDownloads.size > 0) blockers.push("browser-download-active");
  if (
    webContents
      .getAllWebContents()
      .some((contents) => contents.getType() === "webview" && !guests.has(contents.id))
  )
    blockers.push("browser-unknown-guest");
  for (const { contents, frames, opaque, media, automationOpaque, downloads } of guests.values()) {
    if (contents.isDestroyed()) continue;
    if (contents.isDevToolsOpened()) blockers.push("browser-devtools-open");
    if (contents.isLoading()) blockers.push("browser-loading");
    if (downloads > 0) blockers.push("browser-download-active");
    if (opaque || automationOpaque) blockers.push("browser-state-not-restorable");
    if (media || contents.isCurrentlyAudible() || contents.isBeingCaptured())
      blockers.push("browser-media");
    if (
      contents.mainFrame.framesInSubtree.some(
        (frame) => Date.now() - (frames.get(frame.routingId) ?? 0) > 2500,
      )
    )
      blockers.push("browser-uninstrumented-frame");
  }
  return [...new Set(blockers)];
}
