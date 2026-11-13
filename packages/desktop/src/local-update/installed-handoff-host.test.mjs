import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  UpdateAdmissionFence,
  createUpdateQuiescence,
} from "../../../server/src/server/update-quiescence.ts";
const require = createRequire(import.meta.url);
const {
  runInstalledHandoffHost,
} = require("../../../../.lab/registration-cas/local-update/installed-handoff-host.js");
async function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paseo-host-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".paseo-installed");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(home, "userdata"), "unchanged");
  const original = {
    uid: process.getuid(),
    home,
    serverId: "srv_test",
    pid: 100,
    startedAt: "old",
    listen: "127.0.0.1:12345",
    version: "1.0.0",
  };
  const cap = {
    schemaVersion: 1,
    token: "a".repeat(32),
    oldRevision: "b".repeat(40),
    nextRevision: "c".repeat(40),
    nextVersion: "1.1.0",
    original,
  };
  const { uid: _uid, ...fields } = original;
  fs.writeFileSync(
    path.join(root, "daemon.json"),
    JSON.stringify({ schemaVersion: 1, approved: true, ...fields }),
    { mode: 0o600 },
  );
  let live = original;
  const fence = new UpdateAdmissionFence();
  let stops = 0;
  const q = createUpdateQuiescence({
    identity: () => "exact-instance",
    fence,
    runtimes: () => [],
    missingIngressCoverage: () => [],
    blockers: () => [],
    stop: async () => {
      assert.equal(fence.enter(), null);
      assert.ok(fs.existsSync(path.join(root, "daemon-update-v1", "hold.json")));
      live = null;
      stops++;
    },
  });
  t.after(() => q.dispose());
  let ticket;
  const host = {
    userHome: home,
    capability: cap,
    runningRevision: cap.nextRevision,
    verifyApproval: async () => {},
    verifyAdmission: async () => {
      ticket = await q.prepare({
        mode: "daemon",
        daemonIdentity: "exact-instance",
        candidateDigest: "d".repeat(64),
      });
      assert.equal(fence.enter(), null);
    },
    readExactInstance: async () => live,
    stopAfterDurablePrepare: async (_expected, persist) => q.commitToShutdown(ticket, persist),
    startApprovedRevision: async () => {
      live = { ...original, pid: 101, startedAt: "new", version: "1.1.0" };
      return live;
    },
  };
  return { home, root, host, fence, stops: () => stops };
}
test("real fence+durable store+CAS composition preserves identity and blocks new work", async (t) => {
  const f = await fixture(t);
  const receipt = await runInstalledHandoffHost(f.host);
  assert.equal(f.stops(), 1);
  assert.equal(receipt.instance.home, f.home);
  assert.equal(receipt.instance.serverId, "srv_test");
  assert.equal(f.fence.enter(), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "daemon.json"))).pid, 101);
  assert.equal(fs.readFileSync(path.join(f.home, "userdata"), "utf8"), "unchanged");
  await runInstalledHandoffHost(f.host);
  assert.equal(f.stops(), 1);
});
test("failure retains host lock and cannot trigger another lifecycle run", async (t) => {
  const f = await fixture(t);
  f.host.startApprovedRevision = async () => {
    throw Error("fake start failed");
  };
  await assert.rejects(runInstalledHandoffHost(f.host), /fake start failed/);
  assert.equal(f.fence.enter(), null);
  await assert.rejects(runInstalledHandoffHost(f.host), { code: "EEXIST" });
  assert.equal(f.stops(), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "daemon.json"))).pid, 100);
});
test("competing whole-run operation is excluded before daemon actions", async (t) => {
  const f = await fixture(t);
  let resume;
  let entered;
  const enteredPromise = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    resume = r;
  });
  const start = f.host.startApprovedRevision;
  f.host.startApprovedRevision = async (...args) => {
    entered();
    await gate;
    return start(...args);
  };
  const running = runInstalledHandoffHost(f.host);
  await enteredPromise;
  await assert.rejects(runInstalledHandoffHost(f.host), { code: "EEXIST" });
  resume();
  await running;
  assert.equal(f.stops(), 1);
});
