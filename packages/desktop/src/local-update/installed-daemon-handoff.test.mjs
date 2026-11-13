import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHandoffStore, runExactDaemonHandoff } from "./installed-daemon-handoff.ts";
async function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paseo-handoff-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".paseo-installed"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, "user-data"), "unchanged");
  const original = {
    uid: process.getuid(),
    home,
    serverId: "srv_test",
    pid: 100,
    startedAt: "old",
    listen: "127.0.0.1:12345",
    version: "1.0.0",
  };
  const capability = {
    schemaVersion: 1,
    token: "a".repeat(32),
    oldRevision: "b".repeat(40),
    nextRevision: "c".repeat(40),
    nextVersion: "1.1.0",
    original,
  };
  const store = await createHandoffStore(home, process.getuid());
  let live = original,
    registration = original;
  const events = [];
  const port = {
    exclusive: async (f) => f(),
    verifyApproval: async () => {},
    verifyAdmission: async () => {},
    readRegistration: async () => registration,
    readInstance: async () => live,
    stopOfficial: async () => {
      assert.ok(await store.read("hold"));
      events.push("stop");
      live = null;
    },
    startOfficial: async (revision) => {
      events.push("start");
      live = {
        ...original,
        pid: 101,
        startedAt: "new",
        version: revision === capability.nextRevision ? "1.1.0" : "1.0.0",
      };
      return live;
    },
    refreshRegistration: async (expected, receipt) => {
      assert.deepEqual(registration, expected);
      assert.ok(await store.read("receipt"));
      registration = receipt.instance;
      events.push("refresh");
    },
  };
  return {
    home,
    original,
    capability,
    store,
    port,
    events,
    setLive: (v) => {
      live = v;
    },
    setRegistration: (v) => {
      registration = v;
    },
  };
}
test("hold durable before stop, exact receipt before CAS, reentry does not stop again", async (t) => {
  const f = await fixture(t);
  await runExactDaemonHandoff(f.capability, f.capability.nextRevision, f.store, f.port);
  assert.deepEqual(f.events, ["stop", "start", "refresh"]);
  await runExactDaemonHandoff(f.capability, f.capability.nextRevision, f.store, f.port);
  assert.deepEqual(f.events, ["stop", "start", "refresh"]);
  assert.equal(fs.readFileSync(path.join(f.home, "user-data"), "utf8"), "unchanged");
});
test("registration conflict and unapproved revision never stop", async (t) => {
  const f = await fixture(t);
  f.setRegistration({ ...f.original, serverId: "other" });
  await assert.rejects(
    runExactDaemonHandoff(f.capability, f.capability.nextRevision, f.store, f.port),
    /Registration changed/,
  );
  await assert.rejects(
    runExactDaemonHandoff(f.capability, "d".repeat(40), f.store, f.port),
    /Unapproved/,
  );
  assert.deepEqual(f.events, []);
});
test("failed start preserves hold and old registration; old revision may recover", async (t) => {
  const f = await fixture(t);
  const start = f.port.startOfficial;
  f.port.startOfficial = async () => {
    throw Error("failed");
  };
  await assert.rejects(
    runExactDaemonHandoff(f.capability, f.capability.nextRevision, f.store, f.port),
    /failed/,
  );
  assert.deepEqual(await f.port.readRegistration(), f.original);
  assert.equal(await f.store.read("receipt"), null);
  f.port.startOfficial = start;
  const receipt = await runExactDaemonHandoff(
    f.capability,
    f.capability.oldRevision,
    f.store,
    f.port,
  );
  assert.equal(receipt.instance.version, "1.0.0");
});
test("other live instance is not silently adopted and hold cannot be overwritten", async (t) => {
  const f = await fixture(t);
  await f.store.write("hold", f.capability);
  f.setLive({ ...f.original, pid: 999 });
  await assert.rejects(
    runExactDaemonHandoff(f.capability, f.capability.nextRevision, f.store, f.port),
    /Unexpected/,
  );
  await assert.rejects(f.store.write("hold", f.capability), { code: "EEXIST" });
  assert.deepEqual(f.events, []);
});
test("denied admission does not create hold or stop", async (t) => {
  const f = await fixture(t);
  f.port.verifyAdmission = async () => {
    throw Error("active jobs");
  };
  await assert.rejects(
    runExactDaemonHandoff(f.capability, f.capability.nextRevision, f.store, f.port),
    /active jobs/,
  );
  assert.equal(await f.store.read("hold"), null);
  assert.deepEqual(f.events, []);
});
