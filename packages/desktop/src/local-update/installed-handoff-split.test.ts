import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  prepareInstalledReplacement,
  resumeInstalledReplacement,
} from "./installed-handoff-split.js";
import {
  UpdateAdmissionFence,
  createUpdateQuiescence,
} from "../../../server/src/server/update-quiescence.js";
import type { ApprovedHandoffHost } from "./installed-handoff-host.js";
import type { HandoffIdentity } from "./installed-daemon-handoff.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-split-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".paseo-installed");
  await mkdir(root, { mode: 0o700 });
  const original: HandoffIdentity = {
    uid: process.getuid!(),
    home,
    serverId: "srv_fixture",
    pid: 100,
    startedAt: "old",
    listen: "127.0.0.1:12345",
    version: "1.0.0",
  };
  const { uid: _uid, ...fields } = original;
  await writeFile(
    path.join(root, "daemon.json"),
    JSON.stringify({ schemaVersion: 1, approved: true, ...fields }),
    { mode: 0o600 },
  );
  await writeFile(path.join(home, "user-data"), "preserved");
  let live: HandoffIdentity | null = original;
  let starts = 0;
  let stops = 0;
  const fence = new UpdateAdmissionFence();
  const quiescence = createUpdateQuiescence({
    identity: () => "fixture",
    fence,
    runtimes: () => [],
    missingIngressCoverage: () => [],
    blockers: () => [],
    stop: async () => {
      expect(fence.enter()).toBeNull();
      live = null;
      stops++;
    },
  });
  cleanups.push(async () => quiescence.dispose());
  let ticket: Awaited<ReturnType<typeof quiescence.prepare>>;
  const cap = {
    schemaVersion: 1 as const,
    token: "a".repeat(32),
    oldRevision: "b".repeat(40),
    nextRevision: "c".repeat(40),
    nextVersion: "1.1.0",
    original,
  };
  const host: ApprovedHandoffHost = {
    userHome: home,
    capability: cap,
    runningRevision: cap.oldRevision,
    verifyApproval: async () => {},
    verifyAdmission: async () => {
      ticket = await quiescence.prepare({
        mode: "daemon",
        daemonIdentity: "fixture",
        candidateDigest: "d".repeat(64),
      });
    },
    readExactInstance: async () => live,
    stopAfterDurablePrepare: async (_expected, persist) => {
      await quiescence.commitToShutdown(ticket, persist);
    },
    startApprovedRevision: async (revision) => {
      starts++;
      live = {
        ...original,
        pid: 101,
        startedAt: "new",
        version: revision === cap.nextRevision ? cap.nextVersion : original.version,
      };
      return live;
    },
  };
  return {
    home,
    root,
    host,
    fence,
    starts: () => starts,
    stops: () => stops,
    setLive: (value: HandoffIdentity | null) => {
      live = value;
    },
  };
}
it("persists stop across app exit, then resumes and CASes same home/server without re-stopping", async () => {
  const f = await fixture();
  await prepareInstalledReplacement(f.host);
  expect(f.starts()).toBe(0);
  expect(f.stops()).toBe(1);
  expect(f.fence.enter()).toBeNull();
  // New host object models a new signed app process; no in-memory ticket is reused.
  const next = {
    ...f.host,
    runningRevision: f.host.capability.nextRevision,
    verifyAdmission: async () => {
      throw Error("must not request old lease");
    },
  };
  const receipt = await resumeInstalledReplacement(next);
  expect(receipt.instance.home).toBe(f.home);
  expect(receipt.instance.serverId).toBe("srv_fixture");
  expect(f.starts()).toBe(1);
  expect(f.stops()).toBe(1);
  await resumeInstalledReplacement(next);
  expect(f.starts()).toBe(1);
  expect(JSON.parse(await readFile(path.join(f.root, "daemon.json"), "utf8")).pid).toBe(101);
  expect(await readFile(path.join(f.home, "user-data"), "utf8")).toBe("preserved");
});
it("verified original recovery build can resume stopped home without deleting data", async () => {
  const f = await fixture();
  await prepareInstalledReplacement(f.host);
  const receipt = await resumeInstalledReplacement({ ...f.host });
  expect(receipt.revision).toBe(f.host.capability.oldRevision);
  expect(receipt.instance.version).toBe("1.0.0");
});
it("unexpected concurrent daemon is not stopped or adopted", async () => {
  const f = await fixture();
  await prepareInstalledReplacement(f.host);
  f.setLive({ ...f.host.capability.original, pid: 999 });
  await expect(
    resumeInstalledReplacement({ ...f.host, runningRevision: f.host.capability.nextRevision }),
  ).rejects.toThrow("Unexpected live");
  expect(f.starts()).toBe(0);
  expect(f.stops()).toBe(1);
});
it("failed new startup retains lock and original registration rather than blind fallback", async () => {
  const f = await fixture();
  await prepareInstalledReplacement(f.host);
  const next = {
    ...f.host,
    runningRevision: f.host.capability.nextRevision,
    startApprovedRevision: async () => {
      throw Error("start failed");
    },
  };
  await expect(resumeInstalledReplacement(next)).rejects.toThrow("start failed");
  await expect(resumeInstalledReplacement(f.host)).rejects.toMatchObject({ code: "EEXIST" });
  expect(JSON.parse(await readFile(path.join(f.root, "daemon.json"), "utf8")).pid).toBe(100);
});
it("interrupted stop retains hold and lock and cannot silently start", async () => {
  const f = await fixture();
  f.host.stopAfterDurablePrepare = async (_expected, persist) => {
    await persist();
    throw Error("interrupted");
  };
  await expect(prepareInstalledReplacement(f.host)).rejects.toThrow("interrupted");
  await expect(
    resumeInstalledReplacement({ ...f.host, runningRevision: f.host.capability.nextRevision }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(f.starts()).toBe(0);
});
