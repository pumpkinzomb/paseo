import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import { prepareManagedDetach, resumeRetiredPurges } from "./managed-worktree-retirement.mjs";
import { prepareManagedWorktree } from "./prepare-managed-worktree.mjs";
import { managedDependencyFixture as fixture } from "./managed-worktree-test-fixture.mjs";

test("registered dependencies detach then purge while source/history remain; resume restores", async (t) => {
  const f = await fixture(t),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence);
  const result = tx.commitSync();
  assert.equal(result.state, "retired");
  await assert.rejects(fs.stat(path.join(f.root, "node_modules")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.root, "history"), "utf8"), "conversation");
  assert.equal((await tx.purge()).state, "purged");
  assert.equal((await tx.purge()).state, "already-purged");
  const restored = await prepareManagedWorktree(
    { PASEO_WORKTREE_PATH: f.root, PASEO_WORKTREE_DEPENDENCY_CONTEXT: JSON.stringify(f.context) },
    {
      prepare: async (options) => {
        assert.equal(options.allowInstall, false);
        await fs.mkdir(path.join(f.root, "node_modules"));
        await fs.writeFile(path.join(f.root, "node_modules/payload"), "dependency");
        return { mode: "reuse", donor: f.context.donor, entries: f.receipt.entries };
      },
    },
  );
  assert.equal(restored.mode, "reuse");
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/payload"), "utf8"), "dependency");
});
test("modified or extra dependency content cannot be retired", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "node_modules/payload"), "user change");
  await assert.rejects(prepareManagedDetach(f.registry, f.id, f.evidence), /payload changed/);
  await fs.writeFile(path.join(f.root, "node_modules/payload"), "dependency");
  await fs.writeFile(path.join(f.root, "node_modules/extra"), "keep");
  await assert.rejects(prepareManagedDetach(f.registry, f.id, f.evidence), /unregistered/);
});
test("mutation after preflight aborts and releases setup lock", async (t) => {
  const f = await fixture(t),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence);
  await fs.writeFile(path.join(f.root, "node_modules/payload"), "new");
  assert.throws(() => tx.commitSync(), /changed-after-preflight/);
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/payload"), "utf8"), "new");
  await assert.rejects(fs.stat(path.join(f.root, ".managed-dependency-setup.lock")), {
    code: "ENOENT",
  });
});
test("forged deployed evidence and registry IDs fail before detach", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareManagedDetach(f.registry, "../root", f.evidence), /registry-id/);
  await assert.rejects(
    prepareManagedDetach(f.registry, f.id, { ...f.evidence, releaseDigest: "b".repeat(64) }),
    /evidence-changed/,
  );
});
test("cancelled final gate releases preflight lock without moving files", async (t) => {
  const f = await fixture(t),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence);
  tx.abortSync();
  tx.abortSync();
  assert.throws(() => tx.commitSync(), /closed/);
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/payload"), "utf8"), "dependency");
});

test("partial rename failure rolls all dependency roots back", async (t) => {
  const f = await fixture(t, { nested: true }),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence),
    original = sync.renameSync;
  sync.renameSync = (from, to) => {
    if (from === path.join(f.root, "packages/pkg/node_modules"))
      throw new Error("fixture rename failure");
    return original(from, to);
  };
  try {
    assert.throws(() => tx.commitSync(), /fixture rename failure/);
  } finally {
    sync.renameSync = original;
  }
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/payload"), "utf8"), "dependency");
  assert.equal(
    await fs.readFile(path.join(f.root, "packages/pkg/node_modules/payload"), "utf8"),
    "dependency",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, ".managed-dependencies.json"), "utf8")).state,
    undefined,
  );
});
test("receipt symlink replacement after preflight is rejected without overwriting target", async (t) => {
  const f = await fixture(t),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence),
    receipt = path.join(f.root, ".managed-dependencies.json"),
    outside = path.join(f.base, "outside.json");
  await fs.writeFile(outside, "keep");
  await fs.unlink(receipt);
  await fs.symlink(outside, receipt);
  assert.throws(() => tx.commitSync(), /receipt-alias/);
  assert.equal(await fs.readFile(outside, "utf8"), "keep");
});
test("final sync validation benchmark on 1000 fixture payloads", async (t) => {
  const f = await fixture(t, { fileCount: 1000 }),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence),
    start = performance.now();
  tx.commitSync();
  t.diagnostic(`1000-file final check+detach: ${(performance.now() - start).toFixed(1)} ms`);
  await tx.purge();
});

test("startup resumes committed partial purge but never prepared or recovery transactions", async (t) => {
  const f = await fixture(t),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence),
    result = tx.commitSync(),
    journal = path.join(result.retiredRoot, "transaction.json");
  const transaction = JSON.parse(await fs.readFile(journal, "utf8"));
  await fs.writeFile(journal, JSON.stringify({ ...transaction, state: "purging" }));
  await fs.unlink(path.join(result.retiredRoot, "node_modules/payload"));
  const resumed = await resumeRetiredPurges(f.registry);
  assert.equal(resumed[0].state, "purged");
  assert.equal(await fs.readFile(path.join(f.root, "history"), "utf8"), "conversation");
  await fs.writeFile(journal, JSON.stringify({ ...transaction, state: "recovery-required" }));
  assert.deepEqual(await resumeRetiredPurges(f.registry), []);
});
test("first rename failure restores the durable admission marker", async (t) => {
  const f = await fixture(t),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence),
    original = sync.renameSync;
  sync.renameSync = (from, to) => {
    if (from === path.join(f.root, "node_modules")) throw new Error("first rename failure");
    return original(from, to);
  };
  try {
    assert.throws(() => tx.commitSync(), /first rename failure/);
  } finally {
    sync.renameSync = original;
  }
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, ".managed-dependencies.json"), "utf8")).state,
    undefined,
  );
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/payload"), "utf8"), "dependency");
});
test("a live purge writer prevents concurrent deletion", async (t) => {
  const f = await fixture(t),
    tx = await prepareManagedDetach(f.registry, f.id, f.evidence),
    result = tx.commitSync(),
    lock = path.join(result.retiredRoot, "purge.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: "fixture-live" }));
  await assert.rejects(tx.purge(), /purge-writer-still-active/);
  assert.equal(
    await fs.readFile(path.join(result.retiredRoot, "node_modules/payload"), "utf8"),
    "dependency",
  );
  await fs.unlink(lock);
  assert.equal((await tx.purge()).state, "purged");
});
