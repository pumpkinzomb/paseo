import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { atomicJson, manifestDigest, scanRelease } from "./dev-update-store.mjs";
import {
  registerDependencyScratch,
  withDependencyScratchLease,
  cleanupCompletedDependencies,
} from "./dev-update-cleanup.mjs";
import { assertLocalPaths } from "./isolated-lab.mjs";

async function fixture(t, automatic = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paseo-cleanup-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releases = path.join(root, "releases"),
    donorRoot = path.join(releases, "donor"),
    managedRoot = path.join(root, "managed"),
    scratchRoot = path.join(managedRoot, "scratch"),
    registry = path.join(root, "registry"),
    source = path.join(root, "source");
  for (const directory of [donorRoot, managedRoot, scratchRoot, registry, source])
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(donorRoot, "node_modules/pkg"), { recursive: true });
  await fs.writeFile(path.join(donorRoot, "node_modules/pkg/index.js"), "verified code\n");
  await fs.writeFile(path.join(donorRoot, "node_modules/pkg/data.json"), "{}\n");
  await fs.symlink("index.js", path.join(donorRoot, "node_modules/pkg/alias.js"));
  await fs.writeFile(path.join(donorRoot, "source.js"), "keep source\n");
  const manifest = {
    schemaVersion: 1,
    id: "donor",
    sourceRevision: "a".repeat(40),
    stateCompatibility: "preserve",
    entries: await scanRelease(donorRoot),
  };
  await atomicJson(path.join(donorRoot, "release.json"), manifest);
  await fs.cp(path.join(donorRoot, "node_modules"), path.join(scratchRoot, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await fs.writeFile(path.join(scratchRoot, "source.js"), "private unfinished source\n");
  const options = {
    registry,
    managedRoot,
    scratchRoot,
    dependencyRoots: ["node_modules"],
    donor: { releases, id: "donor", digest: manifestDigest(manifest) },
    protectedPaths: [source],
    automatic,
    minFileBytes: 0,
  };
  return {
    root,
    donorRoot,
    scratchRoot,
    options,
    record: await registerDependencyScratch(options),
  };
}
const exists = async (file) =>
  fs.access(file).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

test("explicit completed finish automatically removes only registered exact copies and preserves restore proof", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.scratchRoot, "node_modules/unknown-cache"), "retain me");
  await fs.writeFile(path.join(f.scratchRoot, "node_modules/pkg/data.json"), "changed\n");
  const result = await withDependencyScratchLease(f.record, async (lease) => {
    await lease.complete();
    return 1;
  });
  assert.equal(result.cleanup.state, "dependencies-pruned");
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/index.js")), false);
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/alias.js")), false);
  assert.equal(
    await fs.readFile(path.join(f.scratchRoot, "node_modules/pkg/data.json"), "utf8"),
    "changed\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.scratchRoot, "node_modules/unknown-cache"), "utf8"),
    "retain me",
  );
  assert.equal(
    await fs.readFile(path.join(f.scratchRoot, "source.js"), "utf8"),
    "private unfinished source\n",
  );
  assert.equal(
    await fs.readFile(path.join(f.donorRoot, "node_modules/pkg/index.js"), "utf8"),
    "verified code\n",
  );
  const marker = JSON.parse(
    await fs.readFile(path.join(f.scratchRoot, ".dependencies-pruned.json")),
  );
  assert.ok(marker.restoreEntries["node_modules/pkg/index.js"].sha256);
  assert.equal(marker.restoreOnlyMissing, true);
  assert.throws(() => assertLocalPaths({ root: f.scratchRoot }), /restore the recorded/);
  await cleanupCompletedDependencies(f.record);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(f.scratchRoot, ".dependencies-pruned.json"))),
    marker,
  );
});

test("no automatic opt-in means dry run after completion; explicit invocation remains guarded", async (t) => {
  const f = await fixture(t, false);
  assert.equal(
    (await withDependencyScratchLease(f.record, (lease) => lease.complete())).cleanup.state,
    "planned",
  );
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/index.js")), true);
  await cleanupCompletedDependencies({ ...f.record, dryRun: false });
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/index.js")), false);
});

test("unfinished and throwing owners retain dependencies", async (t) => {
  const f = await fixture(t);
  await assert.rejects(cleanupCompletedDependencies(f.record), /not completed/);
  await assert.rejects(
    withDependencyScratchLease(f.record, async (lease) => {
      await lease.complete();
      throw Error("build failed with unknown children");
    }),
    /build failed/,
  );
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/index.js")), true);
});

test("live child prevents completion and shared lifecycle lock prevents concurrent cleanup", async (t) => {
  const f = await fixture(t),
    child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    await assert.rejects(
      withDependencyScratchLease(f.record, async (lease) => {
        await lease.recordWorker(child.pid);
        await assert.rejects(cleanupCompletedDependencies(f.record), /Lock exists/);
        await lease.complete();
      }),
      /children must exit/,
    );
  } finally {
    const ended = once(child, "exit");
    child.kill("SIGTERM");
    await ended;
  }
  await withDependencyScratchLease(f.record, (lease) => lease.complete());
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/index.js")), false);
});

test("protected runtime or source paths and unowned records are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    registerDependencyScratch({ ...f.options, protectedPaths: [f.scratchRoot] }),
    /protected/,
  );
  await assert.rejects(
    cleanupCompletedDependencies({ ...f.record, ownerToken: "wrong" }),
    /ownership/,
  );
  await assert.rejects(
    registerDependencyScratch({ ...f.options, dependencyRoots: ["../node_modules"] }),
    /relative/,
  );
});

test("changed inode is retained even when bytes match", async (t) => {
  const f = await fixture(t),
    target = path.join(f.scratchRoot, "node_modules/pkg/index.js");
  await fs.rename(target, target + ".old");
  await fs.writeFile(target, "verified code\n");
  await withDependencyScratchLease(f.record, (lease) => lease.complete());
  assert.equal(await fs.readFile(target, "utf8"), "verified code\n");
});

test("ancestor symlink swap fails closed without touching the destination", async (t) => {
  const f = await fixture(t),
    dependencies = path.join(f.scratchRoot, "node_modules");
  await fs.rename(dependencies, dependencies + ".retained");
  await fs.symlink(path.join(f.donorRoot, "node_modules"), dependencies);
  await assert.rejects(
    withDependencyScratchLease(f.record, (lease) => lease.complete()),
    /ancestor/,
  );
  assert.equal(
    await fs.readFile(path.join(f.donorRoot, "node_modules/pkg/index.js"), "utf8"),
    "verified code\n",
  );
});

test("changed backup is never accepted as an equivalent restore copy", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.donorRoot, "node_modules/pkg/index.js"), "mutated donor\n");
  await assert.rejects(
    withDependencyScratchLease(f.record, (lease) => lease.complete()),
    /contents changed/,
  );
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/index.js")), true);
});

test("default threshold leaves small dependencies untouched and does not block the lab", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.options.managedRoot, "other");
  await fs.mkdir(other, { mode: 0o700 });
  await fs.cp(path.join(f.donorRoot, "node_modules"), path.join(other, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const { minFileBytes: _smallTestThreshold, ...options } = f.options;
  const record = await registerDependencyScratch({ ...options, scratchRoot: other });
  const outcome = await withDependencyScratchLease(record, (lease) => lease.complete());
  assert.deepEqual(outcome.cleanup.removed, []);
  assert.equal(await exists(path.join(other, ".dependencies-pruned.json")), false);
});

test("a different process incarnation cannot finish a live owner's record", async (t) => {
  const f = await fixture(t),
    file = path.join(f.record.registry, f.record.id + ".json");
  const record = JSON.parse(await fs.readFile(file));
  record.ownerInstance = "another-process-incarnation";
  record.state = "completed";
  await atomicJson(file, record);
  await assert.rejects(cleanupCompletedDependencies(f.record), /owner is still active/);
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/index.js")), true);
});

test("a promoted scratch is never followed or pruned", async (t) => {
  const f = await fixture(t),
    promoted = path.join(f.options.donor.releases, "new-candidate");
  await fs.rename(f.scratchRoot, promoted);
  await assert.rejects(
    withDependencyScratchLease(f.record, (lease) => lease.complete()),
    { code: "ENOENT" },
  );
  assert.equal(
    await fs.readFile(path.join(promoted, "node_modules/pkg/index.js"), "utf8"),
    "verified code\n",
  );
});

test("an existing source file at the cleanup marker path is never overwritten", async (t) => {
  const f = await fixture(t),
    marker = path.join(f.scratchRoot, ".dependencies-pruned.json");
  await fs.writeFile(marker, JSON.stringify({ userFile: true }));
  await assert.rejects(
    withDependencyScratchLease(f.record, (lease) => lease.complete()),
    /marker changed/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(marker)), { userFile: true });
  assert.equal(await exists(path.join(f.scratchRoot, "node_modules/pkg/index.js")), true);
});
