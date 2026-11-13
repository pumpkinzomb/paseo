import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readRegisteredDaemon,
  isRegisteredCredentialTarget,
  assertRegisteredDaemonEvidence,
  assertDaemonLifecycleAllowed,
} from "./registered-daemon.ts";
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "registered-daemon-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "daemon"),
    dir = path.join(root, ".paseo-installed");
  for (const p of [home, dir]) await fs.mkdir(p, { mode: 0o700 });
  const record = {
    schemaVersion: 1,
    approved: true,
    home,
    serverId: "srv_test",
    pid: 1234,
    startedAt: "2026-11-13T00:00:00Z",
    listen: "127.0.0.1:9999",
    version: "1",
  };
  const file = path.join(dir, "daemon.json");
  const write = () => fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
  await write();
  return {
    record,
    write,
    file,
    input: {
      packaged: true,
      metadata: {
        paseoDistribution: { schemaVersion: 1, channel: "local", updatePolicy: "local-only" },
      },
      userHome: root,
      version: "1",
    },
  };
}
test("registration is local-only opt-in with no userData field", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(readRegisteredDaemon(f.input), f.record);
  assert.equal(readRegisteredDaemon({ ...f.input, packaged: false }), null);
  assert.equal(readRegisteredDaemon({ ...f.input, metadata: {} }), null);
  await fs.unlink(f.file);
  assert.equal(readRegisteredDaemon(f.input), null);
});
test("permissions, remote endpoint, version mismatch and unapproved records fail closed", async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.file, 0o644);
  assert.throws(() => readRegisteredDaemon(f.input), /registration file/);
  await fs.chmod(f.file, 0o600);
  assert.throws(() => readRegisteredDaemon({ ...f.input, version: "2" }), /registration/);
  f.record.listen = "example.com:9999";
  await f.write();
  assert.throws(() => readRegisteredDaemon(f.input), /loopback/);
  f.record.approved = false;
  await f.write();
  assert.throws(() => readRegisteredDaemon(f.input), /registration/);
});
test("evidence pins server identity lifetime and version; lifecycle cannot stop owned elsewhere", async (t) => {
  const f = await fixture(t);
  const instance = { ...f.record, uid: process.getuid() };
  const status = { ...f.record, localDaemon: "running", daemonVersion: "1" };
  assert.doesNotThrow(() => assertRegisteredDaemonEvidence(f.record, instance, status));
  for (const patch of [{ pid: 5555 }, { serverId: "other" }, { startedAt: "changed" }])
    assert.throws(
      () => assertRegisteredDaemonEvidence(f.record, { ...instance, ...patch }, status),
      /reprovision/,
    );
  assert.throws(
    () => assertRegisteredDaemonEvidence(f.record, instance, { ...status, daemonVersion: "2" }),
    /reprovision/,
  );
  assert.throws(() => assertDaemonLifecycleAllowed(f.record), /connection-only/);
  assert.doesNotThrow(() => assertDaemonLifecycleAllowed(null));
});
test("actual manager and bootstrap wire guards before ownership-changing operations", async () => {
  const manager = await fs.readFile(
    new URL("../daemon/daemon-manager.ts", import.meta.url),
    "utf8",
  );
  for (const fn of ["stopDesktopDaemon", "stopCapturedDaemon", "restartDaemon"]) {
    const start = manager.indexOf(`function ${fn}(`);
    assert(start >= 0);
    assert(
      manager.slice(start, start + 350).includes("assertDaemonLifecycleAllowed(registeredDaemon)"),
    );
  }
  assert(manager.includes("if (registeredDaemon || !ownedLaunch) return false"));
  assert(manager.includes("process.env.PASEO_DISABLE_SINGLE_INSTANCE_LOCK"));
  assert(manager.includes("registeredDaemon?.home ?? resolvePaseoHome"));
  const main = await fs.readFile(new URL("../main.ts", import.meta.url), "utf8");
  const start = main.indexOf("async function bootstrap()");
  assert(
    main.indexOf("setupSingleInstanceLock()", start) <
      main.indexOf("await installedUpdate?.resumeIfPending();", start),
  );
  assert(
    main.indexOf("await installedUpdate?.resumeIfPending();", start) <
      main.indexOf("await initializeRegisteredDaemonConnection();", start),
  );
});

test("registered standalone credential accepts only approved endpoint aliases", async (t) => {
  const f = await fixture(t);
  for (const target of ["127.0.0.1:9999", "localhost:9999", "tcp://127.0.0.1:9999"])
    assert.equal(isRegisteredCredentialTarget(f.record, target), true);
  for (const target of [
    "remote.example:9999",
    "127.0.0.1:8888",
    "user@127.0.0.1:9999",
    "127.0.0.1:9999/path",
    "127.0.0.1:9999?x=1",
    null,
  ])
    assert.equal(isRegisteredCredentialTarget(f.record, target), false);
  const instance = { ...f.record, uid: process.getuid(), desktopManaged: false };
  assert.doesNotThrow(() =>
    assertRegisteredDaemonEvidence(f.record, instance, {
      ...f.record,
      localDaemon: "running",
      daemonVersion: "1",
    }),
  );
  const manager = await fs.readFile(
    new URL("../daemon/daemon-manager.ts", import.meta.url),
    "utf8",
  );
  const handler = manager.slice(
    manager.indexOf("desktop_local_credential: async"),
    manager.indexOf("start_desktop_daemon:"),
  );
  assert(handler.includes("readLocalCredentialForTarget(registration.home, registration.listen)"));
  assert(handler.indexOf("return credential") < handler.indexOf("!instance?.desktopManaged"));
});
