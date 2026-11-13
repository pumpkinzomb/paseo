import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { provisionInstalledDaemon } from "./provision-installed-daemon.mjs";
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "provision-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "daemon");
  await fs.mkdir(home, { mode: 0o700 });
  const instance = {
    uid: process.getuid(),
    pid: 1234,
    startedAt: "start",
    serverId: "srv",
    listen: "127.0.0.1:9999",
  };
  const inspect = async () => ({
    instance: { ...instance },
    status: { ...instance, localDaemon: "running", daemonVersion: "1" },
  });
  return {
    input: { home, userHome: root, version: "1" },
    instance,
    inspect,
    file: path.join(root, ".paseo-installed/daemon.json"),
  };
}
test("default dryrun never creates registration; explicit approve writes private record", async (t) => {
  const f = await fixture(t);
  assert.equal((await provisionInstalledDaemon(f.input, f.inspect)).state, "dry-run");
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
  const r = await provisionInstalledDaemon({ ...f.input, approve: true }, f.inspect);
  assert.equal(r.state, "provisioned");
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(f.file))).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file)), r.record);
});
test("replace is explicit and changed daemon before write fails", async (t) => {
  const f = await fixture(t);
  await provisionInstalledDaemon({ ...f.input, approve: true }, f.inspect);
  await assert.rejects(
    provisionInstalledDaemon({ ...f.input, approve: true }, f.inspect),
    /replace/,
  );
  assert.equal(
    (await provisionInstalledDaemon({ ...f.input, approve: true, replace: true }, f.inspect)).state,
    "provisioned",
  );
  let n = 0;
  const inspect = async () => {
    if (++n === 2) f.instance.pid++;
    return f.inspect();
  };
  await assert.rejects(
    provisionInstalledDaemon({ ...f.input, approve: true, replace: true }, inspect),
    /changed/,
  );
});
test("public home, endpoint drift and version mismatch cannot provision", async (t) => {
  const f = await fixture(t);
  await fs.chmod(f.input.home, 0o755);
  await assert.rejects(provisionInstalledDaemon({ ...f.input, approve: true }, f.inspect), /0700/);
  await fs.chmod(f.input.home, 0o700);
  await assert.rejects(
    provisionInstalledDaemon({ ...f.input, version: "2", approve: true }, f.inspect),
    /version/,
  );
  f.instance.listen = "evil.example:9999";
  await assert.rejects(
    provisionInstalledDaemon({ ...f.input, approve: true }, f.inspect),
    /loopback/,
  );
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});
