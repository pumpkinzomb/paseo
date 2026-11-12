import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { scanRelease, atomicJson, manifestDigest } from "./dev-update-store.mjs";
import { reclaimStoppedBuildDependencies } from "./stopped-build-dependencies.mjs";
import { cleanupLegacyLab } from "./cleanup-legacy-lab.mjs";
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stopped-build-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lab = path.join(root, "lab"),
    managedRoot = path.join(lab, ".lab"),
    scratchRoot = path.join(managedRoot, "old-test"),
    control = path.join(root, "control"),
    releases = path.join(root, "releases"),
    donorRoot = path.join(releases, "donor");
  for (const dir of [scratchRoot, control, donorRoot])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const names = ["node_modules/pkg/workerd", "packages/app/node_modules/pkg/libskia.a"];
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(donorRoot, name)), { recursive: true });
    await fs.mkdir(path.dirname(path.join(scratchRoot, name)), { recursive: true });
    await fs.writeFile(path.join(donorRoot, name), Buffer.alloc(1024 * 1024, 1));
    await fs.copyFile(path.join(donorRoot, name), path.join(scratchRoot, name));
  }
  await fs.writeFile(path.join(scratchRoot, "source.txt"), "user work");
  const manifest = {
    schemaVersion: 1,
    id: "donor",
    stateCompatibility: "preserve",
    sourceRevision: "a".repeat(40),
    entries: await scanRelease(donorRoot),
  };
  await atomicJson(path.join(donorRoot, "release.json"), manifest);
  const donor = { releases, id: "donor", digest: manifestDigest(manifest) };
  return {
    lab,
    candidate: "old-test",
    control,
    donor,
    scratchRoot,
    managedRoot,
    names,
    registry: path.join(control, "registry"),
    protectedPaths: [control, releases],
  };
}
test("stopped build reclaims root and nested copies while preserving changed/user files", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.scratchRoot, "node_modules/user-notes"), "keep");
  const result = await reclaimStoppedBuildDependencies(f, { active: async () => false });
  assert.equal(result.state, "dependencies-pruned");
  for (const name of f.names)
    await assert.rejects(fs.access(path.join(f.scratchRoot, name)), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.scratchRoot, "source.txt"), "utf8"), "user work");
  assert.equal(
    await fs.readFile(path.join(f.scratchRoot, "node_modules/user-notes"), "utf8"),
    "keep",
  );
});
test("active or newly active work never loses dependencies", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await reclaimStoppedBuildDependencies(f, { active: async () => true })).reason,
    "process-using-build",
  );
  let calls = 0;
  await assert.rejects(
    reclaimStoppedBuildDependencies(f, { active: async () => ++calls > 1 }),
    /became active/,
  );
  for (const name of f.names) await fs.access(path.join(f.scratchRoot, name));
});
test("legacy dry run is read-only; explicit adoption keeps original source", async (t) => {
  const f = await fixture(t);
  const plan = await cleanupLegacyLab(f);
  assert.equal(plan.state, "planned");
  assert.deepEqual(plan.dependencyRoots.sort(), ["node_modules", "packages/app/node_modules"]);
  assert.deepEqual(await fs.readdir(f.control), []);
  const result = await cleanupLegacyLab({ ...f, apply: true }, { active: async () => false });
  assert.equal(result.state, "dependencies-pruned");
  assert.equal(await fs.readFile(path.join(f.scratchRoot, "source.txt"), "utf8"), "user work");
});
test("legacy aliases, traversal and modified dependency bytes are protected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(cleanupLegacyLab({ ...f, candidate: "../escape" }), /direct/);
  await fs.symlink(f.scratchRoot, path.join(f.managedRoot, "alias"));
  await assert.rejects(cleanupLegacyLab({ ...f, candidate: "alias" }), /owned/);
  await fs.writeFile(path.join(f.scratchRoot, f.names[0]), "modified");
  await cleanupLegacyLab({ ...f, apply: true }, { active: async () => false });
  assert.equal(await fs.readFile(path.join(f.scratchRoot, f.names[0]), "utf8"), "modified");
});
