/* eslint-disable @typescript-eslint/no-explicit-any -- Minimal Electron event-emitter test doubles. */
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  listener: undefined as any,
  all: [] as any[],
}));
vi.mock("electron", () => ({
  ipcMain: {
    on: (_: string, listener: any) => {
      mock.listener = listener;
    },
  },
  webContents: { getAllWebContents: () => mock.all },
}));
import {
  browserUpdateBlockers,
  beginBrowserAutomation,
  installBrowserUpdateGuard,
  markBrowserAutomationOpaque,
  observeBrowserForUpdate,
} from "./browser-guard.js";
it("requires current instrumented frames; untouched page is safe, edited/captured/loading pages are blocked", () => {
  const handlers = new Map<string, any>();
  let loading = false;
  let captured = false;
  const contents: any = {
    id: 1,
    on: (name: string, handler: any) => handlers.set(name, handler),
    once: () => {},
    session: { on: (name: string, handler: any) => handlers.set(name, handler) },
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    isLoading: () => loading,
    isCurrentlyAudible: () => false,
    isBeingCaptured: () => captured,
    getType: () => "webview",
    mainFrame: { framesInSubtree: [{ routingId: 1 }] },
  };
  mock.all = [contents];
  installBrowserUpdateGuard();
  expect(browserUpdateBlockers()).toContain("browser-unknown-guest");
  observeBrowserForUpdate(contents);
  expect(browserUpdateBlockers()).toContain("browser-uninstrumented-frame");
  mock.listener({ sender: contents, senderFrame: { routingId: 1 } }, "ready");
  expect(browserUpdateBlockers()).toEqual([]);
  mock.listener({ sender: contents, senderFrame: { routingId: 1 } }, "opaque");
  expect(browserUpdateBlockers()).toContain("browser-state-not-restorable");
  handlers.get("did-start-navigation")({}, "https://example.com", false, true);
  mock.listener({ sender: contents, senderFrame: { routingId: 1 } }, "ready");
  expect(browserUpdateBlockers()).toEqual([]);
  const finishAutomation = beginBrowserAutomation();
  handlers.get("did-start-navigation")({}, "https://example.com", false, true);
  mock.listener({ sender: contents, senderFrame: { routingId: 1 } }, "ready");
  expect(browserUpdateBlockers()).toContain("browser-state-not-restorable");
  const createdDuringAutomation = { ...contents, id: 2 };
  observeBrowserForUpdate(createdDuringAutomation);
  mock.listener({ sender: createdDuringAutomation, senderFrame: { routingId: 1 } }, "ready");
  finishAutomation();
  expect(browserUpdateBlockers()).toContain("browser-state-not-restorable");
  let downloadDone: any;
  handlers.get("will-download")(
    {},
    {
      once: (_name: string, listener: any) => {
        downloadDone = listener;
      },
    },
    createdDuringAutomation,
  );
  handlers.get("did-start-navigation")({}, "https://example.com/next", false, true);
  mock.listener({ sender: createdDuringAutomation, senderFrame: { routingId: 1 } }, "ready");
  expect(browserUpdateBlockers()).toContain("browser-download-active");
  downloadDone({}, "completed");
  expect(browserUpdateBlockers()).not.toContain("browser-download-active");
  loading = true;
  captured = true;
  expect(browserUpdateBlockers()).toContain("browser-loading");
  expect(browserUpdateBlockers()).toContain("browser-media");
  markBrowserAutomationOpaque();
  expect(browserUpdateBlockers()).toContain("browser-state-not-restorable");
});
