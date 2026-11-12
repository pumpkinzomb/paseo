import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  registerManagedDependencies,
  inspectManagedCandidate,
  runManagedMaintenance,
} from "./managed-worktree-maintenance.mjs";
import { hash } from "./dev-update-store.mjs";
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "managed-maintenance-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source"),
    root = path.join(base, "child"),
    live = path.join(base, "live"),
    registry = path.join(base, "registry");
  await fs.mkdir(source);
  await fs.mkdir(live);
  const git = (...args) =>
    execFileSync("git", args, { cwd: source, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(source, "source.txt"), "source");
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules\nhistory\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const revision = git("rev-parse", "HEAD");
  git("worktree", "add", "-q", "--detach", root);
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "keep"), "deps");
  await fs.writeFile(path.join(root, "history"), "conversation");
  const receipt = {
    schemaVersion: 1,
    root,
    entries: { "node_modules/keep": { sha256: hash("deps"), executable: false } },
  };
  await fs.writeFile(path.join(root, ".managed-dependencies.json"), JSON.stringify(receipt));
  await registerManagedDependencies(
    { maintenanceRegistry: registry, releases: live, protectedRoots: [live], sourceRoot: source },
    root,
    receipt,
  );
  const record = JSON.parse(await fs.readFile(path.join(registry, `${hash(root)}.json`), "utf8"));
  return {
    source,
    root,
    live,
    registry,
    record,
    git,
    evidence: { sourceRevision: revision, releaseDigest: "a".repeat(64) },
  };
}
test("merged and deployed candidate is recorded but no lease means no deletion, repeatedly", async (t) => {
  const f = await fixture(t);
  const first = await runManagedMaintenance(f),
    second = await runManagedMaintenance(f);
  assert.deepEqual(first, second);
  assert.equal(first[0].candidate, true);
  assert.equal(first[0].reason, "exclusive-maintenance-lease-unavailable");
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/keep"), "utf8"), "deps");
  assert.equal(await fs.readFile(path.join(f.root, "history"), "utf8"), "conversation");
});
test("dirty, altered receipt, forged root and symlink ancestor are rejected", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "source.txt"), "changed");
  await assert.rejects(inspectManagedCandidate(f.record, f.evidence), /dirty/);
  await fs.writeFile(path.join(f.root, "source.txt"), "source");
  await fs.writeFile(path.join(f.root, ".managed-dependencies.json"), "{}");
  await assert.rejects(inspectManagedCandidate(f.record, f.evidence), /receipt-changed/);
  await assert.rejects(
    inspectManagedCandidate({ ...f.record, root: f.live }, f.evidence),
    /identity-changed/,
  );
  const alias = path.join(path.dirname(f.root), "alias");
  await fs.symlink(path.dirname(f.root), alias);
  await assert.rejects(
    inspectManagedCandidate({ ...f.record, root: path.join(alias, "child") }, f.evidence),
    /path-alias/,
  );
});
test("worktree commit must be in both main and the running release", async (t) => {
  const f = await fixture(t);
  execFileSync("git", ["-C", f.root, "commit", "--allow-empty", "-qm", "child"]);
  await assert.rejects(inspectManagedCandidate(f.record, f.evidence), /not-merged-to-main/);
  const head = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"]).toString().trim();
  f.git("merge", "--ff-only", head);
  await assert.rejects(inspectManagedCandidate(f.record, f.evidence), /not-in-running-release/);
  assert.equal(
    (await inspectManagedCandidate(f.record, { ...f.evidence, sourceRevision: head })).candidate,
    true,
  );
});
test("registry aliases and malformed records yield skip reports", async (t) => {
  const f = await fixture(t),
    name = `${"b".repeat(64)}.json`;
  await fs.symlink(path.join(f.registry, `${hash(f.root)}.json`), path.join(f.registry, name));
  const results = await runManagedMaintenance(f);
  assert.equal(results.find((x) => x.reason === "registry-file-alias").candidate, false);
});

test("missing deployment evidence skips without changing contents", async (t) => {
  const f = await fixture(t);
  const results = await runManagedMaintenance({ ...f, evidence: {} });
  assert.equal(results[0].reason, "missing-release-evidence");
  const report = JSON.parse(await fs.readFile(path.join(f.registry, "last-result.json"), "utf8"));
  assert.equal(report.inspectionOnly, true);
  assert.equal(report.automaticReclamation, false);
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/keep"), "utf8"), "deps");
});

test("eligible reclaim uses only registry ID and reports outcome without automatic retry", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const results = await runManagedMaintenance({
    ...f,
    reclaim: async (id, evidence) => {
      calls++;
      assert.equal(id, hash(f.root));
      assert.deepEqual(evidence, f.evidence);
      return { detached: true, transactionId: "fixture", purgePending: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(results[0].state, "retired");
  calls = 0;
  const unknown = await runManagedMaintenance({
    ...f,
    reclaim: async () => {
      calls++;
      throw new Error("timed out");
    },
  });
  assert.equal(calls, 1);
  assert.equal(unknown[0].state, "outcome-unknown");
  assert.equal(unknown[0].retry, false);
});

test("known daemon busy refusal is skipped, not uncertain", async (t) => {
  const f = await fixture(t);
  const results = await runManagedMaintenance({
    ...f,
    reclaim: async () => {
      throw new Error("Dependency reclamation blocked: active session");
    },
  });
  assert.equal(results[0].state, "skipped");
  assert.equal(results[0].retry, undefined);
});

async function cherryFixture(t) {
  const f = await fixture(t);
  const childGit = (...args) =>
    execFileSync("git", ["-C", f.root, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  await fs.writeFile(path.join(f.root, "feature.txt"), "completed feature\n");
  childGit("add", "feature.txt");
  childGit("commit", "-qm", "feature");
  const childHead = childGit("rev-parse", "HEAD");
  await fs.writeFile(path.join(f.source, "main-only.txt"), "unrelated\n");
  f.git("add", "main-only.txt");
  f.git("commit", "-qm", "main advanced");
  f.git("cherry-pick", childHead);
  const deployed = f.git("rev-parse", "HEAD");
  assert.notEqual(deployed, childHead);
  return { ...f, childGit, deployed };
}
test("patch-equivalent cherry-pick counts only when present in main and running release", async (t) => {
  const f = await cherryFixture(t);
  await assert.rejects(inspectManagedCandidate(f.record, f.evidence), /not-in-running-release/);
  const result = await inspectManagedCandidate(f.record, {
    ...f.evidence,
    sourceRevision: f.deployed,
  });
  assert.equal(result.candidate, true);
  assert.equal(await fs.readFile(path.join(f.root, "node_modules/keep"), "utf8"), "deps");
  await fs.writeFile(path.join(f.root, "feature.txt"), "uncommitted work");
  await assert.rejects(
    inspectManagedCandidate(f.record, { ...f.evidence, sourceRevision: f.deployed }),
    /worktree-dirty/,
  );
});
test("patch-equivalent history with one unapplied patch is not complete", async (t) => {
  const f = await cherryFixture(t);
  await fs.writeFile(path.join(f.root, "unfinished.txt"), "unfinished\n");
  f.childGit("add", "unfinished.txt");
  f.childGit("commit", "-qm", "unfinished");
  await assert.rejects(
    inspectManagedCandidate(f.record, { ...f.evidence, sourceRevision: f.deployed }),
    /not-merged-to-main/,
  );
});
test("empty or merge-only completion cannot be inferred from matching patches", async (t) => {
  const f = await cherryFixture(t);
  f.childGit("commit", "--allow-empty", "-qm", "metadata not integrated");
  await assert.rejects(
    inspectManagedCandidate(f.record, { ...f.evidence, sourceRevision: f.deployed }),
    /not-merged-to-main/,
  );
  f.childGit("reset", "--hard", "HEAD~");
  f.childGit("merge", "--no-ff", "-m", "merge main", "main");
  await assert.rejects(
    inspectManagedCandidate(f.record, { ...f.evidence, sourceRevision: f.deployed }),
    /not-merged-to-main/,
  );
});

test("a historical cherry-pick later reverted is not considered completed", async (t) => {
  const f = await cherryFixture(t);
  f.git("revert", "--no-edit", f.deployed);
  const reverted = f.git("rev-parse", "HEAD");
  await assert.rejects(
    inspectManagedCandidate(f.record, { ...f.evidence, sourceRevision: reverted }),
    /not-merged-to-main/,
  );
});
test("matching patch IDs with changed final bytes or mode do not authorize retirement", async (t) => {
  const f = await cherryFixture(t);
  await fs.writeFile(path.join(f.source, "feature.txt"), "completed  feature\n");
  f.git("add", "feature.txt");
  f.git("commit", "-qm", "different final whitespace");
  await assert.rejects(
    inspectManagedCandidate(f.record, {
      ...f.evidence,
      sourceRevision: f.git("rev-parse", "HEAD"),
    }),
    /not-merged-to-main/,
  );
  await fs.writeFile(path.join(f.source, "feature.txt"), "completed feature\n");
  await fs.chmod(path.join(f.source, "feature.txt"), 0o755);
  f.git("add", "feature.txt");
  f.git("commit", "-qm", "different mode");
  await assert.rejects(
    inspectManagedCandidate(f.record, {
      ...f.evidence,
      sourceRevision: f.git("rev-parse", "HEAD"),
    }),
    /not-merged-to-main/,
  );
});
