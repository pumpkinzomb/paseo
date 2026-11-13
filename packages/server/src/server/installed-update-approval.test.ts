import { afterEach, it, expect } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyInstalledUpdateApproval } from "./installed-update-approval.js";
const roots: string[] = [];
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
async function fixture() {
  const userHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-approval-")));
  roots.push(userHome);
  const dir = path.join(userHome, ".paseo-installed", "daemon-update-v1");
  await mkdir(path.dirname(dir), { mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  const current = {
    uid: process.getuid!(),
    home: userHome,
    serverId: "srv_fixture",
    pid: 123,
    startedAt: "birth",
    listen: "127.0.0.1:12345",
    version: "1.0.0",
  };
  const capability = {
    schemaVersion: 1,
    token: "a".repeat(32),
    oldRevision: "b".repeat(40),
    nextRevision: "c".repeat(40),
    nextVersion: "1.1.0",
    original: current,
  };
  const candidateDigest = "d".repeat(64);
  await writeFile(
    path.join(dir, "approval.json"),
    JSON.stringify({ schemaVersion: 1, candidateDigest, capability }),
    { mode: 0o600 },
  );
  return { dir, capability, input: { userHome, current, candidateDigest, requireHold: false } };
}
it("binds private approval to digest and exact instance, requires durable hold for commit", async () => {
  const f = await fixture();
  await verifyInstalledUpdateApproval(f.input);
  await expect(verifyInstalledUpdateApproval({ ...f.input, requireHold: true })).rejects.toThrow();
  await writeFile(path.join(f.dir, "hold.json"), JSON.stringify(f.capability), { mode: 0o600 });
  await verifyInstalledUpdateApproval({ ...f.input, requireHold: true });
  await expect(
    verifyInstalledUpdateApproval({ ...f.input, current: { ...f.input.current, pid: 999 } }),
  ).rejects.toThrow("current instance");
  await expect(
    verifyInstalledUpdateApproval({ ...f.input, candidateDigest: "e".repeat(64) }),
  ).rejects.toThrow("current instance");
});
it("rejects conflicting hold and symlink record", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.dir, "hold.json"),
    JSON.stringify({ ...f.capability, token: "f".repeat(32) }),
    { mode: 0o600 },
  );
  await expect(verifyInstalledUpdateApproval({ ...f.input, requireHold: true })).rejects.toThrow(
    "hold mismatch",
  );
  await rm(path.join(f.dir, "approval.json"));
  await symlink("hold.json", path.join(f.dir, "approval.json"));
  await expect(verifyInstalledUpdateApproval(f.input)).rejects.toThrow();
});
