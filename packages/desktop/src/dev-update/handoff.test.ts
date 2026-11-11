import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevUpdateHandoff } from "./handoff.js";
import { createQuitLifecycle } from "../daemon/quit-lifecycle.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

function fixture(options: { isPackaged?: boolean; generation?: string } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paseo-handoff-")));
  directories.push(directory);
  fs.chmodSync(directory, 0o700);
  let windows = 0;
  let contents = 0;
  const quit = vi.fn();
  const onError = vi.fn();
  const handoff = createDevUpdateHandoff({
    isPackaged: false,
    directory,
    generation: "generation-1",
    ...options,
    windowCount: () => windows,
    webContentsCount: () => contents,
    quit,
    onError,
  });
  const request = {
    schemaVersion: 1,
    generation: "generation-1",
    requestId: "request-1",
  };
  const write = (value: unknown = request) =>
    fs.writeFileSync(path.join(directory, "request.json"), JSON.stringify(value));
  const result = () => JSON.parse(fs.readFileSync(path.join(directory, "result.json"), "utf8"));
  return {
    directory,
    handoff,
    quit,
    onError,
    request,
    write,
    result,
    windows: (count: number) => {
      windows = count;
    },
    contents: (count: number) => {
      contents = count;
    },
  };
}

describe("supervisor desktop UI handoff", () => {
  it("waits for windows, then orphan browser guests, without touching renderers", () => {
    const f = fixture();
    f.write();
    f.windows(1);
    f.handoff.poll();
    expect(f.result()).toMatchObject({
      ...f.request,
      state: "waiting-for-windows",
    });
    f.windows(0);
    f.contents(1);
    f.handoff.poll();
    expect(f.quit).not.toHaveBeenCalled();
    f.contents(0);
    f.handoff.poll();
    expect(f.result()).toMatchObject({ ...f.request, state: "ready" });
    expect(f.quit).toHaveBeenCalledOnce();
    expect(() => f.handoff.beginWindowCreation()).toThrow(/committed/);
    f.handoff.poll();
    expect(f.quit).toHaveBeenCalledOnce();
  });

  it("blocks while asynchronous window creation is pending and gates new opens at quit", () => {
    const f = fixture();
    f.write();
    const finish = f.handoff.beginWindowCreation();
    f.handoff.poll();
    expect(f.quit).not.toHaveBeenCalled();
    finish();
    finish();
    f.quit.mockImplementation(() => {
      expect(f.result().state).toBe("ready");
      expect(f.handoff.beginWindowCreation).toThrow();
    });
    f.handoff.poll();
    expect(f.quit).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { schemaVersion: 2, generation: "generation-1", requestId: "a" },
    { schemaVersion: 1, generation: "stale", requestId: "a" },
    { schemaVersion: 1, generation: "generation-1", requestId: "../bad" },
  ])("ignores malformed or stale request %j", (request) => {
    const f = fixture();
    f.write(request);
    f.handoff.poll();
    expect(f.quit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.directory, "result.json"))).toBe(false);
  });

  it("does not opt packaged or unsupervised processes into the protocol", () => {
    for (const options of [{ isPackaged: true }, { generation: undefined }]) {
      const f = fixture(options);
      f.write();
      f.handoff.poll();
      f.handoff.markStarted();
      expect(f.quit).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(f.directory, "started.json"))).toBe(false);
    }
  });

  it("rejects nonprivate control directories and symlink requests", () => {
    const f = fixture();
    f.write();
    fs.chmodSync(f.directory, 0o755);
    f.handoff.poll();
    expect(f.quit).not.toHaveBeenCalled();
    fs.chmodSync(f.directory, 0o700);
    fs.renameSync(path.join(f.directory, "request.json"), path.join(f.directory, "other.json"));
    fs.symlinkSync("other.json", path.join(f.directory, "request.json"));
    f.handoff.poll();
    expect(f.quit).not.toHaveBeenCalled();
  });

  it("rejects a control directory with a symlink ancestor", () => {
    const f = fixture();
    const real = path.join(f.directory, "real");
    const nested = path.join(real, "generation");
    fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
    fs.symlinkSync(real, path.join(f.directory, "alias"));
    fs.writeFileSync(path.join(nested, "request.json"), JSON.stringify(f.request));
    const handoff = createDevUpdateHandoff({
      isPackaged: false,
      directory: path.join(f.directory, "alias", "generation"),
      generation: f.request.generation,
      windowCount: () => 0,
      webContentsCount: () => 0,
      quit: f.quit,
      onError: f.onError,
    });
    handoff.poll();
    handoff.markStarted();
    expect(f.quit).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(nested, "started.json"))).toBe(false);
  });

  it("does not quit when the acknowledgement cannot be written", () => {
    const f = fixture();
    f.write();
    fs.mkdirSync(path.join(f.directory, "result.json"));
    f.handoff.poll();
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.handoff.isCommitted()).toBe(false);
    expect(f.onError).toHaveBeenCalledOnce();
  });

  it("publishes startup acknowledgement and stops polling when disposed", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.handoff.markStarted();
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, "started.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      generation: "generation-1",
      state: "ready",
    });
    f.handoff.start();
    f.handoff.dispose();
    f.write();
    vi.advanceTimersByTime(3000);
    expect(f.quit).not.toHaveBeenCalled();
  });

  it("polls a dotted release request and stops after committing", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.write({ ...f.request, requestId: "release.2026-11-11" });
    f.handoff.start();
    vi.advanceTimersByTime(1000);
    expect(f.result().requestId).toBe("release.2026-11-11");
    expect(f.quit).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3000);
    expect(f.quit).toHaveBeenCalledOnce();
  });

  it("normal quit disposal cancels even an already waiting update", () => {
    const f = fixture();
    f.windows(1);
    f.write();
    f.handoff.poll();
    expect(f.result().state).toBe("waiting-for-windows");
    f.handoff.dispose();
    f.windows(0);
    f.handoff.poll();
    expect(f.handoff.isCommitted()).toBe(false);
    expect(f.quit).not.toHaveBeenCalled();
  });

  it("retains the daemon and skips packaged updater on committed handoff", () => {
    const f = fixture();
    f.write();
    const stop = vi.fn();
    const update = vi.fn();
    const close = vi.fn();
    const exit = vi.fn();
    const lifecycle = createQuitLifecycle({
      app: { exit },
      closeTransportSessions: close,
      isDevUpdateCommitted: f.handoff.isCommitted,
      stopDesktopManagedDaemonIfNeeded: stop,
      installAppUpdateOnQuit: update,
      createUpdateDeadlineSignal: () => AbortSignal.timeout(1000),
      onStopError: vi.fn(),
      onUpdateError: vi.fn(),
    });
    const preventDefault = vi.fn();
    f.quit.mockImplementation(() => lifecycle.handleBeforeQuit({ preventDefault }));
    f.handoff.poll();
    expect(close).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
