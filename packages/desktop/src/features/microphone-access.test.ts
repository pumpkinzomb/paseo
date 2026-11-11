import { describe, expect, it, vi } from "vitest";
import { createMicrophoneAccess, type MicrophoneAccessState } from "./microphone-access.js";
function setup(state: MicrophoneAccessState) {
  const ports = {
    platform: "darwin",
    getStatus: vi.fn(() => state),
    askForAccess: vi.fn().mockResolvedValue(true),
    explainDenied: vi.fn().mockResolvedValue(undefined),
  };
  return { ports, access: createMicrophoneAccess(ports) };
}
describe("macOS microphone permission", () => {
  it("does not ask on startup or status queries; asks when first used", async () => {
    const { ports, access } = setup("not-determined");
    expect(access.getStatus()).toBe("not-determined");
    expect(ports.askForAccess).not.toHaveBeenCalled();
    await expect(access.requestAccess()).resolves.toBe("granted");
    expect(ports.askForAccess).toHaveBeenCalledOnce();
    expect(ports.explainDenied).not.toHaveBeenCalled();
  });
  it("does not prompt again when already granted", async () => {
    const { ports, access } = setup("granted");
    await expect(access.requestAccess()).resolves.toBe("granted");
    expect(ports.askForAccess).not.toHaveBeenCalled();
    expect(ports.explainDenied).not.toHaveBeenCalled();
  });
  it("explains how to open settings when access was already denied", async () => {
    const { ports, access } = setup("denied");
    await expect(access.requestAccess()).resolves.toBe("denied");
    expect(ports.askForAccess).not.toHaveBeenCalled();
    expect(ports.explainDenied).toHaveBeenCalledOnce();
  });
  it("respects a first denial without immediately opening another dialog", async () => {
    const { ports, access } = setup("not-determined");
    ports.askForAccess.mockResolvedValue(false);
    await expect(access.requestAccess()).resolves.toBe("denied");
    expect(ports.explainDenied).not.toHaveBeenCalled();
  });
  it("shares one OS request when voice and dictation start concurrently", async () => {
    const { ports, access } = setup("not-determined");
    let allow!: (value: boolean) => void;
    ports.askForAccess.mockReturnValue(
      new Promise((resolve) => {
        allow = resolve;
      }),
    );
    const first = access.requestAccess();
    const second = access.requestAccess();
    expect(ports.askForAccess).toHaveBeenCalledOnce();
    allow(true);
    await expect(first).resolves.toBe("granted");
    await expect(second).resolves.toBe("granted");
  });
  it("leaves browser permission handling to non-macOS runtimes", async () => {
    const { ports } = setup("unknown");
    ports.platform = "linux";
    await expect(createMicrophoneAccess(ports).requestAccess()).resolves.toBe("granted");
    expect(ports.getStatus).not.toHaveBeenCalled();
    expect(ports.askForAccess).not.toHaveBeenCalled();
  });
});

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>(),
  ask: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getLocale: () => "en" },
  BrowserWindow: { getAllWindows: () => [{ webContents: { id: 7 } }] },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  systemPreferences: {
    getMediaAccessStatus: () => "not-determined",
    askForMediaAccess: ipc.ask,
  },
  ipcMain: {
    handle: (name: string, handler: (event: unknown) => unknown) => ipc.handlers.set(name, handler),
  },
}));
it("blocks update admission until the app microphone request completes", async () => {
  const { updateActivity } = await import("../dev-update/activity.js");
  const { registerMicrophonePermissionHandlers } = await import("./microphone-permissions.js");
  let finish!: (allowed: boolean) => void;
  ipc.ask.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  registerMicrophonePermissionHandlers();
  const frame = { processId: 1, routingId: 2 };
  const event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
  expect(ipc.handlers.get("paseo:microphone:status")!(event)).toBe("not-determined");
  expect(updateActivity.inFlight).toBe(0);
  expect(ipc.ask).not.toHaveBeenCalled();
  expect(() =>
    ipc.handlers.get("paseo:microphone:request")!({
      ...event,
      senderFrame: { processId: 2, routingId: 3 },
    }),
  ).toThrow("only to the app window");
  const pending = ipc.handlers.get("paseo:microphone:request")!(event);
  expect(updateActivity.inFlight).toBe(1);
  expect(updateActivity.seal()).toBe(false);
  finish(true);
  try {
    await expect(pending).resolves.toBe("granted");
  } finally {
    updateActivity.release();
  }
  expect(updateActivity.inFlight).toBe(0);
});
