import { beforeEach, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const state = vi.hoisted(() => ({
  home: "",
  appPath: "",
  version: "1.0.0",
  signed: true,
  prepare: vi.fn(),
  resume: vi.fn(),
  read: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: () => state.appPath, getVersion: () => state.version },
  autoUpdater: {},
}));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => state.home } };
});
vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: unknown,
    _args: unknown,
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const args = _args as string[];
    const requirement = args[args.indexOf("-R") + 1];
    callback(
      state.signed && requirement.startsWith("=anchor apple generic")
        ? null
        : Error("invalid signature or requirement syntax"),
      "",
      "",
    );
  },
}));
vi.mock("@getpaseo/server/daemon-control", () => ({ readDaemonInstance: state.read }));
vi.mock("./official-daemon-lifecycle.js", () => ({
  createOfficialDaemonLifecycle: () => ({
    readExactInstance: state.read,
    startApprovedRevision: vi.fn(),
  }),
}));
vi.mock("./installed-handoff-split.js", () => ({
  prepareInstalledReplacement: state.prepare,
  resumeInstalledReplacement: state.resume,
}));
vi.mock("./squirrel-apply.js", () => ({ requestNativeSquirrelInstall: vi.fn() }));
import { createInstalledUpdateCoordinator } from "./installed-update-coordinator.js";
let approval: Record<string, unknown>;
beforeEach(async () => {
  vi.clearAllMocks();
  state.signed = true;
  state.version = "1.0.0";
  state.home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paseo-coordinator-")));
  state.appPath = path.join(state.home, "Paseo.app", "Contents", "Resources", "app.asar");
  await fs.mkdir(state.appPath, { recursive: true });
  await fs.writeFile(
    path.join(state.appPath, "package.json"),
    JSON.stringify({
      paseoDistribution: { sourceRevision: "b".repeat(40), updatePolicy: "local-only" },
    }),
  );
  await fs.mkdir(path.join(state.home, ".paseo-installed"), { mode: 0o700 });
  approval = {
    schemaVersion: 1,
    approved: true,
    teamId: "ABCDEFGHIJ",
    bundleId: "sh.paseo.local",
    candidateDigest: "d".repeat(64),
    zipSha512: "e".repeat(128),
    capability: {
      schemaVersion: 1,
      token: "a".repeat(32),
      oldRevision: "b".repeat(40),
      nextRevision: "c".repeat(40),
      nextVersion: "1.1.0",
      original: {
        uid: process.getuid!(),
        home: state.home,
        serverId: "srv_test",
        pid: 100,
        startedAt: "old",
        listen: "127.0.0.1:12345",
        version: "1.0.0",
      },
    },
  };
});
afterEach(async () => {
  await fs.rm(state.home, { recursive: true, force: true });
});
async function approve() {
  await fs.writeFile(
    path.join(state.home, ".paseo-installed", "approved-update.json"),
    JSON.stringify(approval),
    { mode: 0o600 },
  );
}
it("absent fixed approval disables coordinator without daemon calls", async () => {
  expect(await createInstalledUpdateCoordinator()).toBeNull();
  expect(state.read).not.toHaveBeenCalled();
});
it("invalid signature denies coordinator even with private approved record", async () => {
  await approve();
  state.signed = false;
  await expect(createInstalledUpdateCoordinator()).rejects.toThrow("invalid signature");
  expect(state.prepare).not.toHaveBeenCalled();
});
it("old startup no-op and wrong renderer token cannot start handoff", async () => {
  await approve();
  const coordinator = await createInstalledUpdateCoordinator();
  await coordinator!.resumeIfPending();
  expect(state.resume).not.toHaveBeenCalled();
  expect((await coordinator!.driver.readStatus()).candidate).toBeUndefined();
  await expect(coordinator!.driver.requestUpdate("f".repeat(64))).rejects.toThrow("Unapproved");
  expect(state.prepare).not.toHaveBeenCalled();
});
it("incomplete hold blocks startup and removes offer", async () => {
  await approve();
  const coordinator = await createInstalledUpdateCoordinator();
  await fs.writeFile(
    path.join(state.home, ".paseo-installed", "daemon-update-v1", "hold.json"),
    JSON.stringify(approval.capability),
    { mode: 0o600 },
  );
  expect((await coordinator!.driver.readStatus()).candidate).toBeUndefined();
  await expect(coordinator!.resumeIfPending()).rejects.toThrow("Incomplete");
  expect(state.resume).not.toHaveBeenCalled();
});
