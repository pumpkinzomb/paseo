import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicJson, hash, inside, privateDirectory } from "./dev-update-store.mjs";
const exec = promisify(execFile);
const git = async (root, ...args) =>
  (await exec("git", args, { cwd: root, maxBuffer: 32 * 1024 ** 2 })).stdout.trim();
const overlaps = (a, b) => a === b || inside(a, b) || inside(b, a);
const identity = (s) => ({ dev: s.dev, ino: s.ino });
async function canonical(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || (await fs.realpath(root)) !== root)
    throw new Error("path-alias");
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not-directory");
  return stat;
}
async function common(root) {
  return fs.realpath(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}
export async function registerManagedDependencies(context, root, receipt) {
  if (!context.maintenanceRegistry) return;
  const registry = context.maintenanceRegistry;
  await privateDirectory(registry);
  await canonical(registry);
  const record = {
    schemaVersion: 1,
    root,
    rootIdentity: identity(await canonical(root)),
    commonDir: await common(root),
    sourceRoot: await fs.realpath(context.sourceRoot),
    releases: context.releases,
    receiptDigest: hash(JSON.stringify(receipt)),
    protectedRoots: [...context.protectedRoots, context.releases, registry],
    registeredAt: new Date().toISOString(),
  };
  await atomicJson(path.join(registry, `${hash(root)}.json`), record);
}
export async function inspectManagedCandidate(record, evidence) {
  if (
    record.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(evidence.sourceRevision ?? "") ||
    !/^[a-f0-9]{64}$/.test(evidence.releaseDigest ?? "")
  )
    throw new Error("missing-release-evidence");
  const stat = await canonical(record.root);
  if (JSON.stringify(identity(stat)) !== JSON.stringify(record.rootIdentity))
    throw new Error("worktree-identity-changed");
  for (const protectedRoot of [...record.protectedRoots, record.sourceRoot]) {
    await canonical(protectedRoot);
    if (overlaps(record.root, protectedRoot)) throw new Error("protected-root-overlap");
  }
  if (
    !(await fs.lstat(path.join(record.root, ".git"))).isFile() ||
    (await common(record.root)) !== record.commonDir ||
    (await common(record.sourceRoot)) !== record.commonDir
  )
    throw new Error("worktree-registration-changed");
  const listed = await git(record.sourceRoot, "worktree", "list", "--porcelain");
  if (!listed.split("\n").includes(`worktree ${record.root}`))
    throw new Error("worktree-unregistered");
  if (
    await git(
      record.root,
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      ".",
      ":(exclude).managed-dependencies.json",
      ":(exclude).managed-dependency-setup.lock",
    )
  )
    throw new Error("worktree-dirty");
  const head = await git(record.root, "rev-parse", "HEAD");
  for (const [ref, reason] of [
    ["refs/heads/main", "not-merged-to-main"],
    [evidence.sourceRevision, "not-in-running-release"],
  ]) {
    try {
      await git(record.sourceRoot, "merge-base", "--is-ancestor", head, ref);
    } catch {
      throw new Error(reason);
    }
  }
  const receiptFile = path.join(record.root, ".managed-dependencies.json");
  if (!(await fs.lstat(receiptFile)).isFile()) throw new Error("receipt-alias");
  const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  if (receipt.root !== record.root || hash(JSON.stringify(receipt)) !== record.receiptDigest)
    throw new Error("dependency-receipt-changed");
  // A completed agent or quiet snapshot cannot fence new sessions, terminals or builds.
  // Until the daemon supports an exclusive maintenance lease there is NO deletion path.
  return {
    state: "skipped",
    candidate: true,
    head,
    reason: "exclusive-maintenance-lease-unavailable",
  };
}
export async function runManagedMaintenance({ registry, evidence, reclaim }) {
  await privateDirectory(registry);
  await canonical(registry);
  const results = [];
  // Only committed detached transactions are resumable; source trees are never touched here.
  const retiredPurges = reclaim
    ? await (await import("./managed-worktree-retirement.mjs")).resumeRetiredPurges(registry)
    : [];
  for (const name of await fs.readdir(registry)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    let record;
    try {
      const file = path.join(registry, name);
      if (!(await fs.lstat(file)).isFile()) throw new Error("registry-file-alias");
      record = JSON.parse(await fs.readFile(file, "utf8"));
      if (name !== `${hash(record.root)}.json`) throw new Error("registry-identity-mismatch");
      const candidate = await inspectManagedCandidate(record, evidence);
      if (!reclaim) results.push({ root: record.root, ...candidate });
      else {
        try {
          const outcome = await reclaim(name.slice(0, -5), evidence);
          results.push({
            root: record.root,
            candidate: true,
            state: outcome?.detached ? "retired" : "skipped",
            ...outcome,
          });
        } catch (error) {
          const blocked =
            error.message.startsWith("Dependency reclamation blocked:") ||
            error.message.startsWith("Daemon does not support");
          results.push({
            root: record.root,
            candidate: true,
            state: blocked ? "skipped" : "outcome-unknown",
            reason: error.message,
            ...(blocked ? {} : { retry: false }),
          });
        }
      }
    } catch (error) {
      results.push({
        root: record?.root,
        state: "skipped",
        candidate: false,
        reason: error.message,
      });
    }
  }
  await atomicJson(path.join(registry, "last-result.json"), {
    checkedAt: new Date().toISOString(),
    inspectionOnly: !reclaim,
    automaticReclamation: Boolean(reclaim),
    evidence,
    retiredPurges,
    results,
  });
  return results;
}
