import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  refreshInstalledRegistration,
} = require("../../../../.lab/registration-cas/local-update/installed-registration-cas.js");
const {
  createHandoffStore,
} = require("../../../../.lab/registration-cas/local-update/installed-daemon-handoff.js");
async function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paseo-cas-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".paseo-installed");
  fs.mkdirSync(root, { mode: 0o700 });
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
  const receipt = {
    schemaVersion: 1,
    token: cap.token,
    revision: cap.nextRevision,
    instance: { ...original, pid: 101, startedAt: "new", version: "1.1.0" },
  };
  const { uid: _uid, ...fields } = original;
  const bytes = JSON.stringify({ schemaVersion: 1, approved: true, ...fields });
  const file = path.join(root, "daemon.json");
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "userdata"), "untouched");
  const store = await createHandoffStore(home, process.getuid());
  await store.write("hold", cap);
  await store.write("receipt", receipt);
  return { home, root, file, bytes, cap, receipt };
}
test("exact CAS atomically replaces registration and retains original private preimage", async (t) => {
  const f = await fixture(t);
  await refreshInstalledRegistration(f.home, f.cap, f.receipt);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).pid, 101);
  const pre = path.join(f.root, "daemon-update-v1", "registration-preimage.json");
  assert.equal(fs.readFileSync(pre, "utf8"), f.bytes);
  assert.equal(fs.statSync(pre).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.root, "provision.lock")), false);
  assert.equal(fs.readFileSync(path.join(f.home, "userdata"), "utf8"), "untouched");
});
test("conflicting registration is preserved and recovery lock retained", async (t) => {
  const f = await fixture(t);
  const changed = JSON.stringify({ ...JSON.parse(f.bytes), pid: 555 });
  fs.writeFileSync(f.file, changed);
  await assert.rejects(refreshInstalledRegistration(f.home, f.cap, f.receipt), /CAS conflict/);
  assert.equal(fs.readFileSync(f.file, "utf8"), changed);
  assert.ok(fs.existsSync(path.join(f.root, "provision.lock")));
});
test("existing provisioning or interrupted CAS lock cannot be reclaimed", async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.root, "provision.lock"), { mode: 0o700 });
  await assert.rejects(refreshInstalledRegistration(f.home, f.cap, f.receipt), { code: "EEXIST" });
  assert.equal(fs.readFileSync(f.file, "utf8"), f.bytes);
});
test("simultaneous adapters have a single winner and never overwrite newer registration", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    refreshInstalledRegistration(f.home, f.cap, f.receipt),
    refreshInstalledRegistration(f.home, f.cap, f.receipt),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).pid, 101);
});
test("changed receipt and symlink registration fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    refreshInstalledRegistration(f.home, f.cap, { ...f.receipt, token: "d".repeat(32) }),
    /Invalid exact/,
  );
  fs.renameSync(f.file, f.file + ".original");
  fs.symlinkSync(f.file + ".original", f.file);
  await assert.rejects(refreshInstalledRegistration(f.home, f.cap, f.receipt));
  assert.equal(fs.readFileSync(f.file + ".original", "utf8"), f.bytes);
});
