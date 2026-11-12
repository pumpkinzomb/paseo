import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneReleases } from "./dev-update-prune.mjs";
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prune-")));
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
  }
  await fs.writeFile(
    path.join(releases, "dependent", ".dependencies-pruned.json"),
    JSON.stringify({ donor: { id: "donor" } }),
  );
  await write("status.json", { releaseId: "metadata" });
  const input = { control, releases, keep: 0, exclude: ["excluded"] },
    deps = { processes: async () => `999999 node ${releases}/process/server.js` };
  return { root, control, releases, write, input, deps };
}
test("dry-run retains selection, metadata, donor, process and explicit exclusion", async (t) => {
  const f = await fixture(t);
  const r = await pruneReleases(f.input, f.deps);
  assert.equal(r.dryRun, true);
  assert.equal(r.state, "planned");
  assert.deepEqual(r.candidates.map((x) => x.id).sort(), ["dependent", "old"]);
  assert.equal(r.estimatedLogicalBytes > 0, true);
  assert.equal((await fs.readdir(f.control)).includes("release-pruning"), false);
  assert.equal((await fs.stat(path.join(f.releases, "old"))).isDirectory(), true);
});
test("apply records before/after deletion and retains protected releases", async (t) => {
  const f = await fixture(t);
  const r = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(r.state, "completed", r.error);
  assert.equal(
    r.candidates.every((x) => x.state === "deleted"),
    true,
  );
  await assert.rejects(fs.stat(path.join(f.releases, "old")), { code: "ENOENT" });
  const files = await fs.readdir(path.join(f.control, "release-pruning"));
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.control, "release-pruning", files[0]))).state,
    "completed",
  );
});
test("symlinks/files excluded, aliased roots and traversal exclusions refused", async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.root, path.join(f.releases, "escape"));
  await fs.writeFile(path.join(f.releases, "file.json"), "{}");
  const r = await pruneReleases(f.input, f.deps);
  assert.equal(r.skipped.length, 2);
  await assert.rejects(pruneReleases({ ...f.input, exclude: ["../escape"] }, f.deps));
  const alias = path.join(f.root, "alias");
  await fs.symlink(f.releases, alias);
  await assert.rejects(pruneReleases({ ...f.input, releases: alias }, f.deps), /canonical/);
});
test("transition and lease block all deletion", async (t) => {
  const f = await fixture(t);
  await f.write("state.json", { transition: { from: { id: "old" } } });
  await f.write("update-lease.json", { state: "active" });
  const r = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(r.state, "blocked");
  assert.equal(r.estimatedLogicalBytes, 0);
  assert.equal(r.blocked.length >= 2, true);
  assert.equal((await fs.stat(path.join(f.releases, "old"))).isDirectory(), true);
});
test("keep retains newest directories and apply requires stopped controller", async (t) => {
  const f = await fixture(t);
  await fs.utimes(path.join(f.releases, "old"), new Date(2100000000000), new Date(2100000000000));
  let r = await pruneReleases({ ...f.input, keep: 1 }, f.deps);
  assert.equal(r.retained.find((x) => x.id === "old").reasons.includes("recent:1"), true);
  await f.write("supervisor.lock", { pid: 123 });
  r = await pruneReleases({ ...f.input, apply: true }, f.deps);
  assert.equal(r.state, "blocked");
});

test("stage process blocks and changed usage leaves a durable failed receipt", async (t) => {
  const f = await fixture(t);
  const blocked = await pruneReleases(f.input, {
    processes: async () => "99999 node dev-update.mjs stage --source /tmp/source",
  });
  assert.equal(blocked.state, "blocked");
  let calls = 0;
  const result = await pruneReleases(
    { ...f.input, apply: true },
    { processes: async () => (++calls > 1 ? `999999 node ${f.releases}/dependent/server.js` : "") },
  );
  assert.equal(result.state, "failed");
  assert.equal((await fs.stat(path.join(f.releases, "dependent"))).isDirectory(), true);
  const files = await fs.readdir(path.join(f.control, "release-pruning"));
  const receipt = JSON.parse(await fs.readFile(path.join(f.control, "release-pruning", files[0])));
  assert.equal(receipt.state, "failed");
});

test("malformed metadata and active selection locks fail closed", async (t) => {
  const f = await fixture(t);
  await f.write("selection.lock", { pid: 123 });
  assert.equal((await pruneReleases({ ...f.input, apply: true }, f.deps)).state, "blocked");
  await fs.writeFile(path.join(f.control, "status.json"), "broken");
  await assert.rejects(pruneReleases(f.input, f.deps), SyntaxError);
});
