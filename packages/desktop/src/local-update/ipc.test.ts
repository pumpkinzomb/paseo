import { describe, expect, it, vi } from "vitest";
import {
  registerLocalUpdateIpc,
  LOCAL_UPDATE_CHANNELS,
  type LocalUpdateDriverStatus,
} from "./ipc.js";
const token = "a".repeat(64);
function setup(enabled?: boolean) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const status: LocalUpdateDriverStatus = {
    currentVersion: "1",
    candidate: { version: "2", token },
    phase: "idle",
  };
  const driver = {
    readStatus: vi.fn(async () => status),
    requestUpdate: vi.fn(async (_token: string) => {}),
  };
  const dispose = registerLocalUpdateIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    },
    isTrustedSender: (event) => event === "trusted",
    productionReady: enabled,
    driver,
  });
  const read = (...args: unknown[]) =>
    handlers.get(LOCAL_UPDATE_CHANNELS.status)!("trusted", ...args);
  const request = (...args: unknown[]) =>
    handlers.get(LOCAL_UPDATE_CHANNELS.request)!("trusted", ...args);
  return { handlers, driver, read, request, dispose, status };
}
describe("local update IPC", () => {
  it("is inert by default and strips the candidate", async () => {
    const x = setup();
    expect(await x.read()).toEqual({ currentVersion: "1", phase: "idle", canApply: false });
    await expect(x.request(token)).rejects.toThrow("not enabled");
    expect(x.driver.requestUpdate).not.toHaveBeenCalled();
  });
  it("rejects untrusted frames before reading anything", async () => {
    const x = setup(true);
    for (const handler of x.handlers.values())
      await expect(handler("foreign", token)).rejects.toThrow("Untrusted");
    expect(x.driver.readStatus).not.toHaveBeenCalled();
  });
  it.each(["/tmp/app", "$(open app)", "a".repeat(63), "a".repeat(65), {}, null])(
    "rejects malformed input %j",
    async (input) => {
      const x = setup(true);
      await expect(x.request(input)).rejects.toThrow("Invalid");
      expect(x.driver.requestUpdate).not.toHaveBeenCalled();
    },
  );
  it("rejects extra args on either channel", async () => {
    const x = setup(true);
    await expect(x.request(token, "path")).rejects.toThrow("Invalid");
    await expect(x.read("path")).rejects.toThrow("Invalid");
  });
  it("returns only approved public fields", async () => {
    const x = setup(true);
    expect(await x.read()).toEqual({
      currentVersion: "1",
      phase: "idle",
      canApply: true,
      candidate: { version: "2", token },
    });
  });
  it("coalesces duplicates, blocks other candidates and prevents replay", async () => {
    const x = setup(true);
    let finish!: () => void;
    x.driver.requestUpdate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const a = x.request(token);
    const b = x.request(token);
    await vi.waitFor(() => expect(x.driver.requestUpdate).toHaveBeenCalledTimes(1));
    await expect(x.request("b".repeat(64))).rejects.toThrow("in progress");
    expect(await x.read()).toEqual({ currentVersion: "1", phase: "applying", canApply: false });
    finish();
    await Promise.all([a, b]);
    await expect(x.request(token)).rejects.toThrow("already used");
  });
  it("rechecks the current candidate and never exposes private driver errors", async () => {
    const x = setup(true);
    await expect(x.request("b".repeat(64))).rejects.toThrow("request failed");
    expect(x.driver.requestUpdate).not.toHaveBeenCalled();
    x.driver.readStatus.mockRejectedValueOnce(new Error("/secret/path"));
    await expect(x.read()).rejects.toThrow("status unavailable");
    x.driver.requestUpdate.mockRejectedValueOnce(new Error("/secret/path"));
    await expect(x.request(token)).rejects.toThrow("request failed");
  });
  it("removes only its two handlers on disposal", () => {
    const x = setup();
    x.dispose();
    expect(x.handlers.size).toBe(0);
  });
});

it("does not start an apply after the bridge is disposed", async () => {
  const x = setup(true);
  const pending = x.request(token);
  x.dispose();
  await expect(pending).rejects.toThrow("request failed");
  expect(x.driver.requestUpdate).not.toHaveBeenCalled();
});

it("preserves the native host identity and permits verified same-version offers", async () => {
  const x = setup(true);
  x.status.serverId = "native-local-host";
  x.status.candidate!.version = x.status.currentVersion;
  expect(await x.read()).toMatchObject({
    serverId: "native-local-host",
    canApply: true,
    candidate: { version: x.status.currentVersion, token },
  });
});

it("restores a failed offer only after a trusted idle retryable status for the same token", async () => {
  const x = setup(true);
  x.driver.requestUpdate.mockImplementationOnce(async () => {
    x.status.phase = "idle";
    x.status.failure = { code: "blocked", retryable: true };
    throw Error("/private/runtime/path");
  });
  await expect(x.request(token)).rejects.toThrow("Local update request failed");
  expect(await x.read()).toMatchObject({
    canApply: true,
    failure: { code: "blocked", retryable: true },
  });
  await expect(x.request(token)).resolves.toBeUndefined();
});
it("keeps uncertain outcomes consumed and supplies a non-retryable public failure", async () => {
  const x = setup(true);
  x.driver.requestUpdate.mockImplementationOnce(async () => {
    x.status.phase = "failed";
    x.status.failure = { code: "recovery_required", retryable: false };
    throw Error("/private/runtime/path");
  });
  await expect(x.request(token)).rejects.toThrow("Local update request failed");
  expect(await x.read()).toMatchObject({
    canApply: false,
    failure: { code: "recovery_required", retryable: false },
  });
  await expect(x.request(token)).rejects.toThrow("already used");
});
