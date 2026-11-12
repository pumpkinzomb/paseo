import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneReleases } from "./dev-update-prune.mjs";
import {
  scanRelease,
  manifestDigest,
  verifyRelease,
} from "./dev-update-store.mjs";
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "prune-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const control = path.join(root, "control"),
    releases = path.join(root, "releases");
  await fs.mkdir(control, { mode: 0o700 });
  await fs.mkdir(releases);
  const write = async (file, value) =>
    fs.writeFile(path.join(control, file), JSON.stringify(value));
  await write("config.json", { releases });
  await write("state.json", {
    current: { id: "current" },
    previous: { id: "previous" },
    pending: { id: "pending" },
  });
  for (const id of [
    "current",
    "previous",
    "pending",
    "old",
    "donor",
    "dependent",
    "process",
    "excluded",
    "metadata",
  ]) {
    await fs.mkdir(path.join(releases, id));
    await fs.writeFile(path.join(releases, id, "payload"), "123");
    await fs.writeFile(
      path.join(releases, id, "release.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        sourceRevision: "a".repeat(40),
        stateCompatibility: "preserve",
        entries: await scanRelease(path.join(releases, id)),
      }),
    );
  }
  await fs.writeFile(
    path.join(releases, "dependent", ".dependencies-pruned.json"),
    JSON.stringify({ donor: { id: "donor" }, restoreOnlyMissing: true }),
  );
  const dependentManifestPath = path.join(
    releases,
    "dependent",
    "release.json",
  );
  const dependentManifest = JSON.parse(
    await fs.readFile(dependentManifestPath),
  );
  dependentManifest.entries = await scanRelease(
    path.join(releases, "dependent"),
  );
  await fs.writeFile(dependentManifestPath, JSON.stringify(dependentManifest));
  await write("status.json", { releaseId: "metadata" });
  const input = { control, releases, keep: 0, exclude: ["excluded"] },
    deps = {
      processes: async () => `999999 node ${releases}/process/server.js`,
    };
  return { root, control, releases, write, input, deps };
}
test("dry-run retains selection, metadata, donor, process and explicit exclusion", async (t) => {
  const f = await fixture(t);
  const r = await pruneReleases(f.input, f.deps);
  assert.equal(r.dryRun, true);
  assert.equal(r.state, "planned");
  assert.deepEqual(r.candidates.map((x) => x.id).sort(), ["dependent", "old"]);
  assert.equal(r.estimatedLogicalBytes > 0, true);
  assert.equal(
    (await fs.readdir(f.control)).includes("release-pruning"),
    false,
  );
  assert.equal(
    (await fs.stat(path.join(f.releases, "old"))).isDirectory(),
    true,
  );
});
test("apply records before/after deletion and retains protected releases", async (t) => {
  const f = await fixture(t);
  const r = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(r.state, "completed", r.error);
  assert.equal(
    r.candidates.every((x) => x.state === "deleted"),
    true,
  );
  await assert.rejects(fs.stat(path.join(f.releases, "old")), {
    code: "ENOENT",
  });
  const files = await fs.readdir(path.join(f.control, "release-pruning"));
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.control, "release-pruning", files[0])),
    ).state,
    "completed",
  );
});
test("symlinks/files excluded, aliased roots and traversal exclusions refused", async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.root, path.join(f.releases, "escape"));
  await fs.writeFile(path.join(f.releases, "file.json"), "{}");
  const r = await pruneReleases(f.input, f.deps);
  assert.equal(r.skipped.length, 2);
  await assert.rejects(
    pruneReleases({ ...f.input, exclude: ["../escape"] }, f.deps),
  );
  const alias = path.join(f.root, "alias");
  await fs.symlink(f.releases, alias);
  await assert.rejects(
    pruneReleases({ ...f.input, releases: alias }, f.deps),
    /canonical/,
  );
});
test("transition and lease block all deletion", async (t) => {
  const f = await fixture(t);
  await f.write("state.json", { transition: { from: { id: "old" } } });
  await f.write("update-lease.json", { state: "active" });
  const r = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(r.state, "blocked");
  assert.equal(r.estimatedLogicalBytes, 0);
  assert.equal(r.blocked.length >= 2, true);
  assert.equal(
    (await fs.stat(path.join(f.releases, "old"))).isDirectory(),
    true,
  );
});
test("keep retains newest directories and apply requires stopped controller", async (t) => {
  const f = await fixture(t);
  await fs.utimes(
    path.join(f.releases, "old"),
    new Date(2100000000000),
    new Date(2100000000000),
  );
  let r = await pruneReleases({ ...f.input, keep: 1 }, f.deps);
  assert.equal(
    r.retained.find((x) => x.id === "old").reasons.includes("recent:1"),
    true,
  );
  await f.write("supervisor.lock", { pid: 123 });
  r = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(r.state, "blocked");
});

test("stage process blocks and changed usage leaves a durable failed receipt", async (t) => {
  const f = await fixture(t);
  const blocked = await pruneReleases(f.input, {
    processes: async () =>
      "99999 node dev-update.mjs stage --source /tmp/source",
  });
  assert.equal(blocked.state, "blocked");
  let calls = 0;
  const result = await pruneReleases(
    { ...f.input, apply: true },
    {
      processes: async () =>
        ++calls > 1 ? `999999 node ${f.releases}/dependent/server.js` : "",
    },
  );
  assert.equal(result.state, "failed");
  assert.equal(
    (await fs.stat(path.join(f.releases, "dependent"))).isDirectory(),
    true,
  );
  const files = await fs.readdir(path.join(f.control, "release-pruning"));
  const receipt = JSON.parse(
    await fs.readFile(path.join(f.control, "release-pruning", files[0])),
  );
  assert.equal(receipt.state, "failed");
});

test("malformed metadata and active selection locks fail closed", async (t) => {
  const f = await fixture(t);
  await f.write("selection.lock", { pid: 123 });
  assert.equal(
    (await pruneReleases({ ...f.input, apply: true }, f.deps)).state,
    "blocked",
  );
  await fs.writeFile(path.join(f.control, "status.json"), "broken");
  await assert.rejects(pruneReleases(f.input, f.deps), SyntaxError);
});

test("completed release provenance chains do not retain intermediate donors", async (t) => {
  const f = await fixture(t);
  for (const [id, donor] of [
    ["current", "old"],
    ["old", "dependent"],
  ]) {
    await fs.writeFile(
      path.join(f.releases, id, "release.json"),
      JSON.stringify({
        ...JSON.parse(
          await fs.readFile(path.join(f.releases, id, "release.json")),
        ),
        dependencies: { mode: "reuse", donor: { id: donor } },
      }),
    );
  }
  const current = path.join(f.releases, "current");
  const manifest = {
    schemaVersion: 1,
    id: "current",
    sourceRevision: "a".repeat(40),
    stateCompatibility: "preserve",
    dependencies: { mode: "reuse", donor: { id: "old" } },
    base: "old",
    hotfix: { baselineRelease: path.join(f.releases, "old") },
    entries: await scanRelease(current),
  };
  await fs.writeFile(
    path.join(current, "release.json"),
    JSON.stringify(manifest),
  );
  const digest = manifestDigest(manifest);
  await verifyRelease(f.releases, "current", digest);
  const r = await pruneReleases(f.input, f.deps);
  assert.deepEqual(r.candidates.map((item) => item.id).sort(), [
    "dependent",
    "old",
  ]);
  assert.equal(
    r.retained
      .find((item) => item.id === "donor")
      .reasons.includes(
        "release-reference:dependent/.dependencies-pruned.json",
      ),
    true,
  );
  assert.match(r.note, /shared APFS blocks/);
  const applied = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(applied.state, "completed");
  await verifyRelease(f.releases, "current", digest);
  assert.equal(
    (await fs.stat(path.join(f.releases, "donor"))).isDirectory(),
    true,
  );
  // The current manifest's provenance stays intact even after its donor is gone.
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.releases, "current", "release.json")),
    ).dependencies.donor.id,
    "old",
  );
  await assert.rejects(fs.stat(path.join(f.releases, "old")), {
    code: "ENOENT",
  });
});

test("controller cleanup registry and managed receipts retain restore donors", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.control, "cleanup-records"));
  await f.write("cleanup-records/task.json", {
    state: "dependencies-pruned",
    donor: { id: "old" },
  });
  const workspace = path.join(f.root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(
    path.join(workspace, ".managed-dependencies.json"),
    JSON.stringify({ donor: { id: "dependent" } }),
  );
  await fs.mkdir(path.join(f.control, "managed-worktrees"));
  await f.write("managed-worktrees/workspace.json", { root: workspace });
  const r = await pruneReleases(f.input, f.deps);
  assert.equal(
    r.retained
      .find((item) => item.id === "old")
      .reasons.includes("metadata:cleanup-records/task.json"),
    true,
  );
  assert.equal(
    r.retained
      .find((item) => item.id === "dependent")
      .reasons.includes(`managed-receipt:${workspace}`),
    true,
  );
  assert.equal(r.candidates.length, 0);
});

test("unowned directories are never deletion candidates", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.releases, "personal-notes"));
  await fs.writeFile(
    path.join(f.releases, "personal-notes", "important"),
    "retain",
  );
  const result = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(result.state, "completed");
  assert.deepEqual(result.skipped, [
    { id: "personal-notes", reason: "missing-release-manifest" },
  ]);
  assert.equal(
    await fs.readFile(
      path.join(f.releases, "personal-notes", "important"),
      "utf8",
    ),
    "retain",
  );
});

test("invalid and aliased release manifests fail closed", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.releases, "old", "release.json");
  await fs.writeFile(file, JSON.stringify({ id: "another" }));
  await assert.rejects(
    pruneReleases(f.input, f.deps),
    /Invalid release manifest/,
  );
  await fs.unlink(file);
  await fs.symlink(path.join(f.releases, "current", "release.json"), file);
  await assert.rejects(pruneReleases(f.input, f.deps), /manifest alias/);
});

test("manifest changes after planning stop deletion", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await pruneReleases(
    { ...f.input, apply: true },
    {
      processes: async () => {
        if (++calls === 2)
          await fs.writeFile(
            path.join(f.releases, "dependent", "release.json"),
            "{}",
          );
        return "";
      },
    },
  );
  assert.equal(result.state, "failed");
  assert.match(
    result.error,
    /Invalid release manifest|Release manifest changed/,
  );
  assert.equal(
    (await fs.stat(path.join(f.releases, "dependent"))).isDirectory(),
    true,
  );
});

test("payload added after validation is not deleted", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.releases, "dependent", "personal-file"),
    "retain",
  );
  const result = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(result.state, "failed");
  assert.match(result.error, /Release contents changed/);
  assert.equal(
    await fs.readFile(
      path.join(f.releases, "dependent", "personal-file"),
      "utf8",
    ),
    "retain",
  );
});
