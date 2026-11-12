import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { reclaimOwnedBuildOutputs } from "./owned-build-outputs.mjs";
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "owned-build-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root }).toString().trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(root, "source.txt"), "source");
  git("add", ".");
  git("commit", "-qm", "source");
  const sourceRevision = git("rev-parse", "HEAD");
  for (const relative of [
    "node_modules/pkg",
    "packages/app/node_modules/pkg",
    "packages/app/dist",
  ]) {
    await fs.mkdir(path.join(root, relative), { recursive: true });
    await fs.writeFile(path.join(root, relative, "generated.bin"), "rebuildable");
  }
  await fs.writeFile(path.join(root, "source.txt"), "keep modified source");
  return { root, sourceRevision, identity: await fs.lstat(root), git };
}
test("fresh-install failed build discards all generated dependencies and dist, retaining source and notes", async (t) => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.root, "diagnostic.log"), "error details");
  const result = await reclaimOwnedBuildOutputs(f, { active: async () => false });
  assert.deepEqual(result.removed.sort(), [
    "node_modules",
    "packages/app/dist",
    "packages/app/node_modules",
  ]);
  assert.equal(await fs.readFile(path.join(f.root, "source.txt"), "utf8"), "keep modified source");
  assert.equal(await fs.readFile(path.join(f.root, "diagnostic.log"), "utf8"), "error details");
  assert.deepEqual((await reclaimOwnedBuildOutputs(f, { active: async () => false })).removed, []);
});
test("tracked output roots, active processes and changed identity remain untouched", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await reclaimOwnedBuildOutputs(f, { active: async () => true })).reason,
    "process-using-build",
  );
  await assert.rejects(
    reclaimOwnedBuildOutputs(
      { ...f, identity: { dev: -1, ino: -1 } },
      { active: async () => false },
    ),
    /ownership/,
  );
  f.git("add", "packages/app/dist");
  const result = await reclaimOwnedBuildOutputs(f, { active: async () => false });
  assert.deepEqual(result.retained, ["packages/app/dist"]);
  await fs.access(path.join(f.root, "packages/app/dist/generated.bin"));
});
test("output ancestor aliases cannot redirect removal", async (t) => {
  const f = await setup(t);
  await fs.rename(path.join(f.root, "packages"), path.join(f.root, "other-packages"));
  await fs.symlink(path.join(f.root, "other-packages"), path.join(f.root, "packages"));
  const result = await reclaimOwnedBuildOutputs(f, { active: async () => false });
  assert.ok(result.retained.includes("packages/app/dist"));
  await fs.access(path.join(f.root, "other-packages/app/dist/generated.bin"));
});
