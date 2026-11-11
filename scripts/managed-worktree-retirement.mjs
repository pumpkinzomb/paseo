import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { atomicJson, hash, privateDirectory, verifyRelease } from "./dev-update-store.mjs";
import {
  dependencyInputs,
  prepareDependencies,
  verifyDependencyEntries,
} from "./dev-update-dependencies.mjs";
import { inspectManagedCandidate } from "./managed-worktree-maintenance.mjs";
const exec = promisify(execFile);
const stamp = (s) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs, s.nlink];
function canonicalSync(directory) {
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    sync.realpathSync(directory) !== directory ||
    !sync.lstatSync(directory).isDirectory()
  )
    throw new Error("retirement-path-alias");
}
function writeSync(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = sync.openSync(temp, "wx", 0o600);
  try {
    sync.writeFileSync(fd, JSON.stringify(data));
    sync.fsyncSync(fd);
  } finally {
    sync.closeSync(fd);
  }
  sync.renameSync(temp, file);
}
function safeName(name) {
  if (
    path.isAbsolute(name) ||
    name.includes("\\") ||
    name.split("/").some((p) => !p || p === "." || p === "..") ||
    !/(^|\/)node_modules\//.test(name)
  )
    throw new Error("invalid-dependency-name");
  return name;
}
async function exactTree(root, entries, allowMissing = false) {
  const roots = [
    ...new Set(
      Object.keys(entries).map((name) =>
        safeName(name).slice(0, name.indexOf("node_modules/") + 12),
      ),
    ),
  ].sort();
  if (!roots.length) throw new Error("no-registered-dependencies");
  const snapshots = new Map(),
    seen = new Set();
  async function walk(relative) {
    const absolute = path.join(root, relative);
    canonicalSync(absolute);
    snapshots.set(relative, stamp(await fs.lstat(absolute)));
    for (const item of await fs.readdir(absolute, { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      if (item.isDirectory()) await walk(name);
      else {
        if (!Object.hasOwn(entries, name)) throw new Error("unregistered-dependency-content");
        seen.add(name);
        snapshots.set(name, stamp(await fs.lstat(path.join(root, name))));
      }
    }
  }
  for (const relative of roots) {
    for (let parent = path.dirname(relative); parent !== "."; parent = path.dirname(parent))
      canonicalSync(path.join(root, parent));
    if (!allowMissing || sync.existsSync(path.join(root, relative))) await walk(relative);
  }
  if (!allowMissing && seen.size !== Object.keys(entries).length)
    throw new Error("dependency-entry-missing");
  await verifyDependencyEntries(
    root,
    Object.fromEntries(Object.entries(entries).filter(([name]) => seen.has(name))),
  );
  for (const [name, entry] of Object.entries(entries))
    if (
      entry.link !== undefined &&
      (path.isAbsolute(entry.link) ||
        !path.resolve(path.dirname(path.join(root, name)), entry.link).startsWith(`${root}/`))
    )
      throw new Error("dependency-link-escape");
  return { roots, snapshots };
}
function assertSnapshots(root, snapshots) {
  canonicalSync(root);
  const parents = new Set();
  for (const name of snapshots.keys())
    for (
      let parent = path.dirname(path.join(root, name));
      parent !== root;
      parent = path.dirname(parent)
    )
      parents.add(parent);
  for (const parent of parents) canonicalSync(parent);
  for (const [name, expected] of snapshots) {
    const absolute = path.join(root, name);
    if (JSON.stringify(stamp(sync.lstatSync(absolute))) !== JSON.stringify(expected))
      throw new Error("dependency-changed-after-preflight");
  }
}
async function readRegular(file) {
  if (!(await fs.lstat(file)).isFile()) throw new Error("retirement-record-alias");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export async function prepareManagedDetach(registry, registryId, evidence) {
  if (!/^[a-f0-9]{64}$/.test(registryId)) throw new Error("invalid-registry-id");
  canonicalSync(registry);
  const registryStat = sync.statSync(registry);
  if ((registryStat.mode & 0o777) !== 0o700 || registryStat.uid !== process.getuid())
    throw new Error("registry-not-private");
  const control = path.dirname(registry);
  if (path.basename(registry) !== "managed-worktrees") throw new Error("invalid-registry-location");
  const config = await readRegular(path.join(control, "config.json"));
  const state = await readRegular(path.join(control, "state.json"));
  if (state.transition || state.current?.digest !== evidence.releaseDigest)
    throw new Error("running-release-evidence-changed");
  const current = await verifyRelease(config.releases, state.current.id, state.current.digest);
  if (current.manifest.sourceRevision !== evidence.sourceRevision)
    throw new Error("running-revision-mismatch");
  const record = await readRegular(path.join(registry, `${registryId}.json`));
  if (hash(record.root) !== registryId || record.releases !== config.releases)
    throw new Error("registry-binding-mismatch");
  await inspectManagedCandidate(record, evidence);
  const root = record.root,
    receiptFile = path.join(root, ".managed-dependencies.json");
  const receipt = await readRegular(receiptFile);
  if (receipt.state && receipt.state !== "prepared") throw new Error("retirement-already-started");
  // Revalidate a retained sealed donor and tracked install inputs before any detach.
  const donorResult = await prepareDependencies({
    source: root,
    releases: record.releases,
    donor: receipt.donor,
    allowInstall: false,
    minFreeBytes: 0,
    clone: async () => {},
  });
  if (
    JSON.stringify(Object.entries(donorResult.entries).sort()) !==
    JSON.stringify(Object.entries(receipt.entries).sort())
  )
    throw new Error("receipt-does-not-match-donor");
  if (JSON.stringify(await dependencyInputs(root)) !== JSON.stringify(receipt.inputs))
    throw new Error("dependency-inputs-changed");
  const lockFile = path.join(root, ".managed-dependency-setup.lock");
  const lock = sync.openSync(lockFile, "wx", 0o600);
  let released = false,
    committed = false;
  let cleanupAbandoned = () => {};
  const abortSync = () => {
    if (!released) {
      released = true;
      sync.closeSync(lock);
      sync.unlinkSync(lockFile);
      cleanupAbandoned();
    }
  };
  try {
    const { roots, snapshots } = await exactTree(root, receipt.entries);
    const tracked = new Set(
      (
        await exec("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 32 * 1024 ** 2 })
      ).stdout.split("\0"),
    );
    if (Object.keys(receipt.entries).some((name) => tracked.has(name)))
      throw new Error("tracked-dependency-content");
    const parent = path.join(registry, "retired");
    await privateDirectory(parent);
    canonicalSync(parent);
    const id = crypto.randomUUID(),
      retiredRoot = path.join(parent, id);
    await privateDirectory(retiredRoot);
    if ((await fs.stat(retiredRoot)).dev !== (await fs.stat(root)).dev)
      throw new Error("retirement-cross-device");
    for (const relative of roots)
      await fs.mkdir(path.dirname(path.join(retiredRoot, relative)), {
        recursive: true,
        mode: 0o700,
      });
    const transaction = {
      schemaVersion: 1,
      id,
      registryId,
      root,
      retiredRoot,
      roots,
      receiptDigest: record.receiptDigest,
      donor: { releases: record.releases, ...receipt.donor },
      entries: receipt.entries,
      state: "prepared",
      retiredIdentity: [sync.statSync(retiredRoot).dev, sync.statSync(retiredRoot).ino],
      evidence,
    };
    const journal = path.join(retiredRoot, "transaction.json");
    await atomicJson(journal, transaction);
    cleanupAbandoned = () => {
      try {
        canonicalSync(retiredRoot);
        if (
          !sync.lstatSync(journal).isFile() ||
          JSON.stringify(JSON.parse(sync.readFileSync(journal, "utf8"))) !==
            JSON.stringify(transaction)
        )
          return;
        sync.unlinkSync(journal);
        const dirs = new Set([retiredRoot]);
        for (const relative of roots)
          for (
            let dir = path.dirname(path.join(retiredRoot, relative));
            dir.startsWith(`${retiredRoot}/`);
            dir = path.dirname(dir)
          )
            dirs.add(dir);
        for (const dir of [...dirs].sort((a, b) => b.length - a.length)) sync.rmdirSync(dir);
      } catch {
        /* Never remove unknown content or mask the primary operation. */
      }
    };
    const rootIdentity = [sync.statSync(root).dev, sync.statSync(root).ino];
    return {
      root,
      abortSync,
      commitSync() {
        if (released) throw new Error("retirement-transaction-closed");
        const moved = [];
        let transactionStarted = false;
        try {
          canonicalSync(registry);
          canonicalSync(retiredRoot);
          if (
            JSON.stringify([sync.statSync(root).dev, sync.statSync(root).ino]) !==
            JSON.stringify(rootIdentity)
          )
            throw new Error("worktree-root-changed");
          if (!sync.lstatSync(receiptFile).isFile()) throw new Error("receipt-alias");
          if (
            hash(JSON.stringify(JSON.parse(sync.readFileSync(receiptFile, "utf8")))) !==
            record.receiptDigest
          )
            throw new Error("receipt-changed");
          const latestState = JSON.parse(
            sync.readFileSync(path.join(control, "state.json"), "utf8"),
          );
          if (latestState.current?.digest !== evidence.releaseDigest || latestState.transition)
            throw new Error("running-release-changed");
          assertSnapshots(root, snapshots);
          writeSync(journal, { ...transaction, state: "detaching" });
          transactionStarted = true;
          // Durable admission block BEFORE the first rename, including process death mid-batch.
          writeSync(receiptFile, {
            ...receipt,
            state: "retirement-recovery-required",
            retirement: { id, retiredRoot },
          });
          for (const relative of roots) {
            sync.renameSync(path.join(root, relative), path.join(retiredRoot, relative));
            moved.push(relative);
          }
          writeSync(receiptFile, { ...receipt, state: "retired", retirement: { id, retiredRoot } });
          writeSync(journal, { ...transaction, state: "retired" });
          committed = true;
          return { state: "retired", transactionId: id, root, retiredRoot };
        } catch (error) {
          let rollbackError;
          for (const relative of moved.toReversed()) {
            try {
              if (sync.existsSync(path.join(root, relative)))
                throw new Error("rollback-target-exists", { cause: error });
              sync.renameSync(path.join(retiredRoot, relative), path.join(root, relative));
            } catch (failure) {
              rollbackError = failure;
            }
          }
          if (!rollbackError && transactionStarted) {
            writeSync(receiptFile, receipt);
            writeSync(journal, { ...transaction, state: "rolled-back" });
          } else if (rollbackError) {
            writeSync(receiptFile, {
              ...receipt,
              state: "retirement-recovery-required",
              retirement: { id, retiredRoot },
            });
            writeSync(journal, {
              ...transaction,
              state: "recovery-required",
              error: String(rollbackError),
            });
          }
          throw error;
        } finally {
          abortSync();
        }
      },
      async purge() {
        if (!committed) throw new Error("retirement-not-committed");
        const result = await exec(
          process.execPath,
          [fileURLToPath(import.meta.url), "purge", retiredRoot],
          { maxBuffer: 1024 * 1024 },
        );
        return JSON.parse(result.stdout);
      },
    };
  } catch (error) {
    abortSync();
    throw error;
  }
}
function acquirePurgeWriter(retiredRoot) {
  canonicalSync(retiredRoot);
  const file = path.join(retiredRoot, "purge.lock"),
    recovery = path.join(retiredRoot, "purge-lock-recovery.lock");
  const token = crypto.randomUUID();
  const open = () => {
    const fd = sync.openSync(file, "wx", 0o600);
    try {
      sync.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      sync.fsyncSync(fd);
    } finally {
      sync.closeSync(fd);
    }
  };
  try {
    open();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Serialize only dead-owner takeover. Ordinary contenders never remove a lock.
    const guard = sync.openSync(recovery, "wx", 0o600);
    try {
      if (!sync.lstatSync(file).isFile()) throw new Error("purge-lock-alias", { cause: error });
      const owner = JSON.parse(sync.readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string")
        throw new Error("invalid-purge-lock", { cause: error });
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (probe) {
        if (probe.code === "ESRCH") dead = true;
        else throw probe;
      }
      if (!dead) throw new Error("purge-writer-still-active", { cause: error });
      sync.unlinkSync(file);
      open();
    } finally {
      sync.closeSync(guard);
      sync.unlinkSync(recovery);
    }
  }
  return () => {
    if (JSON.parse(sync.readFileSync(file, "utf8")).token !== token)
      throw new Error("purge-lock-owner-changed");
    sync.unlinkSync(file);
  };
}
export async function purgeRetiredDependencies(retiredRoot) {
  const release = acquirePurgeWriter(retiredRoot);
  try {
    return await purgeRetiredDependenciesOwned(retiredRoot);
  } finally {
    release();
  }
}
async function purgeRetiredDependenciesOwned(retiredRoot) {
  canonicalSync(retiredRoot);
  if (
    path.basename(path.dirname(retiredRoot)) !== "retired" ||
    path.basename(path.dirname(path.dirname(retiredRoot))) !== "managed-worktrees"
  )
    throw new Error("invalid-retired-location");
  const file = path.join(retiredRoot, "transaction.json"),
    transaction = await readRegular(file);
  if (transaction.state === "purged") return { state: "already-purged" };
  if (
    transaction.retiredRoot !== retiredRoot ||
    transaction.id !== path.basename(retiredRoot) ||
    !["retired", "purging"].includes(transaction.state)
  )
    throw new Error("retired-transaction-invalid");
  if (
    JSON.stringify([sync.statSync(retiredRoot).dev, sync.statSync(retiredRoot).ino]) !==
      JSON.stringify(transaction.retiredIdentity) ||
    (sync.statSync(retiredRoot).mode & 0o777) !== 0o700
  )
    throw new Error("retired-identity-changed");
  const donor = await verifyRelease(
    transaction.donor.releases,
    transaction.donor.id,
    transaction.donor.digest,
  );
  for (const [name, entry] of Object.entries(transaction.entries))
    if (JSON.stringify(donor.manifest.entries[name]) !== JSON.stringify(entry))
      throw new Error("retired-donor-mismatch");
  const { snapshots } = await exactTree(
    retiredRoot,
    transaction.entries,
    transaction.state === "purging",
  );
  assertSnapshots(retiredRoot, snapshots);
  await atomicJson(file, { ...transaction, state: "purging" });
  let bytes = 0;
  // Synchronous unlink in this private detached tree; never traverse source or recursively rm.
  for (const name of Object.keys(transaction.entries)) {
    if (!snapshots.has(name)) continue;
    const target = path.join(retiredRoot, name);
    bytes += sync.lstatSync(target).size;
    sync.unlinkSync(target);
  }
  for (const name of [...snapshots.keys()].sort((a, b) => b.length - a.length)) {
    const target = path.join(retiredRoot, name);
    if (sync.existsSync(target) && sync.lstatSync(target).isDirectory()) sync.rmdirSync(target);
  }
  await atomicJson(file, {
    ...transaction,
    state: "purged",
    logicalBytes: bytes,
    purgedAt: new Date().toISOString(),
  });
  return { state: "purged", logicalBytes: bytes };
}

export async function resumeRetiredPurges(registry) {
  canonicalSync(registry);
  const parent = path.join(registry, "retired"),
    results = [];
  try {
    canonicalSync(parent);
  } catch (error) {
    if (error.code === "ENOENT") return results;
    throw error;
  }
  for (const name of await fs.readdir(parent)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const retiredRoot = path.join(parent, name);
    try {
      canonicalSync(retiredRoot);
      const transaction = await readRegular(path.join(retiredRoot, "transaction.json"));
      if (!["retired", "purging"].includes(transaction.state)) continue;
      const result = await exec(
        process.execPath,
        [fileURLToPath(import.meta.url), "purge", retiredRoot],
        { maxBuffer: 1024 * 1024 },
      );
      results.push({ transactionId: name, ...JSON.parse(result.stdout) });
    } catch (error) {
      results.push({ transactionId: name, state: "retained", reason: error.message });
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "purge" || !process.argv[3] || process.argv.length !== 4)
    throw new Error("Usage: managed-worktree-retirement.mjs purge RETIRED_ROOT");
  purgeRetiredDependencies(process.argv[3])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
