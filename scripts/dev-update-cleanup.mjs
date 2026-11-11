import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  acquireLock,
  atomicJson,
  hash,
  inside,
  privateDirectory,
  readJson,
  verifyRelease,
} from "./dev-update-store.mjs";

const ownerInstance = crypto.randomUUID();
const overlap = (a, b) => a === b || inside(a, b) || inside(b, a);
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino });
const equalIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid recorded process identity");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function canonical(directory) {
  const resolved = path.resolve(directory);
  if (resolved !== directory || (await fs.realpath(directory)) !== resolved)
    throw new Error("Cleanup path must be canonical and not an alias");
  return resolved;
}
function relativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/).some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid dependency relative path");
  return value;
}
async function checkRoot(record, targetRelative) {
  await canonical(record.scratchRoot);
  const stat = await fs.lstat(record.scratchRoot);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !equalIdentity(stat, record.rootIdentity) ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Scratch identity or owner changed");
  for (const protectedPath of record.protectedPaths) {
    if (overlap(record.scratchRoot, protectedPath))
      throw new Error("Scratch overlaps protected state");
  }
  const ancestors = targetRelative ? [] : Object.entries(record.directories);
  if (targetRelative)
    for (let parent = path.dirname(targetRelative); parent !== "."; parent = path.dirname(parent))
      ancestors.push([parent, record.directories[parent]]);
  for (const [relative, expected] of ancestors) {
    const directory = path.join(record.scratchRoot, relative);
    const current = await fs.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || !equalIdentity(current, expected))
      throw new Error("Dependency ancestor changed");
  }
}
async function matches(root, relative, expected) {
  const target = path.join(root, relative);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (expected.link !== undefined) {
    if (!stat.isSymbolicLink() || (await fs.readlink(target)) !== expected.link) return null;
    if (
      path.isAbsolute(expected.link) ||
      !inside(root, path.resolve(path.dirname(target), expected.link))
    )
      throw new Error("Dependency link escapes its root");
  } else if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    Boolean(stat.mode & 0o111) !== expected.executable ||
    hash(await fs.readFile(target)) !== expected.sha256
  )
    return null;
  return stat;
}
async function recordFile(registry, id) {
  await privateDirectory(registry);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid cleanup record ID");
  return path.join(registry, `${id}.json`);
}
async function locked(input, operation) {
  const file = await recordFile(input.registry, input.id);
  const unlock = await acquireLock(input.registry, `${input.id}.lifecycle.lock`);
  try {
    const record = await readJson(file);
    if (
      record.schemaVersion !== 1 ||
      record.ownerToken !== input.ownerToken ||
      record.id !== input.id
    )
      throw new Error("Cleanup ownership mismatch");
    return await operation(record, file);
  } finally {
    await unlock();
  }
}

async function bindRegistryScope(registry, managedRoot) {
  const scopeUnlock = await acquireLock(registry, "scope.lock");
  try {
    const scopeFile = path.join(registry, "scope.json");
    let scope;
    try {
      scope = await readJson(scopeFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (scope && (scope.schemaVersion !== 1 || scope.managedRoot !== managedRoot))
      throw new Error("Registry managed root changed");
    if (!scope) await atomicJson(scopeFile, { schemaVersion: 1, managedRoot });
  } finally {
    await scopeUnlock();
  }
}

async function registerCopies(scratchRoot, sealed, roots, minFileBytes) {
  const entries = {},
    directories = {};
  for (const [relative, expected] of Object.entries(sealed.manifest.entries)) {
    if (!roots.some((root) => inside(root, relative))) continue;
    let candidate;
    try {
      candidate = await fs.lstat(path.join(scratchRoot, relative));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (candidate.size < minFileBytes || (minFileBytes > 0 && !candidate.isFile())) continue;
    const target = await matches(scratchRoot, relative, expected);
    if (!target) continue;
    if (
      expected.link !== undefined &&
      !inside(scratchRoot, await fs.realpath(path.join(scratchRoot, relative)))
    )
      throw new Error("Dependency link escapes scratch");
    const backup = await matches(sealed.root, relative, expected);
    if (!backup || equalIdentity(target, backup))
      throw new Error("Dependency is not an independent verified copy");
    for (let parent = path.dirname(relative); parent !== "."; parent = path.dirname(parent)) {
      const ancestor = await fs.lstat(path.join(scratchRoot, parent));
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
        throw new Error("Dependency ancestor is an alias");
      directories[parent] = identity(ancestor);
    }
    entries[relative] = { expected, identity: identity(target) };
  }
  return { entries, directories };
}

/** Only creators of private, disposable scratch copies may register them. No directory discovery. */
export async function registerDependencyScratch({
  registry,
  managedRoot,
  scratchRoot,
  dependencyRoots,
  donor,
  protectedPaths,
  automatic = false,
  minFileBytes = 1024 ** 2,
}) {
  await privateDirectory(registry);
  await privateDirectory(managedRoot);
  managedRoot = await canonical(managedRoot);
  if (overlap(managedRoot, await canonical(donor.releases)))
    throw new Error("Restore releases must be outside managed scratch");
  if (!Number.isSafeInteger(minFileBytes) || minFileBytes < 0)
    throw new Error("Invalid cleanup payload threshold");
  await bindRegistryScope(registry, managedRoot);
  scratchRoot = await canonical(scratchRoot);
  if (!inside(await canonical(managedRoot), scratchRoot)) throw new Error("Scratch is not managed");
  if (!Array.isArray(protectedPaths) || !protectedPaths.length)
    throw new Error("Protected source/home/profile paths required");
  if (!Array.isArray(dependencyRoots) || !dependencyRoots.length || typeof automatic !== "boolean")
    throw new Error("Explicit dependency roots required");
  const protectedRoots = [
    ...new Set([
      await canonical(registry),
      await canonical(donor.releases),
      ...(await Promise.all(protectedPaths.map(canonical))),
    ]),
  ];
  if (protectedRoots.some((root) => overlap(root, scratchRoot)))
    throw new Error("Scratch overlaps protected state");
  const sealed = await verifyRelease(donor.releases, donor.id, donor.digest);
  const stat = await fs.lstat(scratchRoot);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error("Scratch must be private and owned");
  const roots = dependencyRoots.map(relativePath);
  if (roots.some((root) => path.basename(root) !== "node_modules"))
    throw new Error("Only dependency directories may be registered");
  const { entries, directories } = await registerCopies(scratchRoot, sealed, roots, minFileBytes);
  const id = hash(scratchRoot),
    file = await recordFile(registry, id);
  const unlock = await acquireLock(registry, `${id}.lifecycle.lock`);
  try {
    try {
      await fs.access(file);
      throw new Error("Scratch is already registered");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const ownerToken = crypto.randomUUID();
    const record = {
      schemaVersion: 1,
      id,
      ownerToken,
      ownerPid: process.pid,
      ownerInstance,
      managedRoot,
      minFileBytes,
      scratchRoot,
      rootIdentity: identity(stat),
      dependencyRoots: roots,
      directories,
      entries,
      donor,
      protectedPaths: protectedRoots,
      automatic,
      workers: [],
      state: "active",
      removed: [],
    };
    await checkRoot(record);
    await atomicJson(file, record);
    return { registry, id, ownerToken };
  } finally {
    await unlock();
  }
}
async function writePrunedMarker(record, value) {
  const file = path.join(record.scratchRoot, ".dependencies-pruned.json");
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Cleanup marker is not owned", { cause: error });
    const existing = await readJson(file);
    if (JSON.stringify(existing) !== JSON.stringify(value))
      throw new Error("Cleanup marker changed; source retained", { cause: error });
    return;
  }
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(record.scratchRoot, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function assertCompleted(record) {
  if (record.state !== "completed" && record.state !== "dependencies-pruned")
    throw new Error("Scratch task has not completed");
  if (
    (record.ownerPid !== process.pid || record.ownerInstance !== ownerInstance) &&
    alive(record.ownerPid)
  )
    throw new Error("Scratch owner is still active");
  if (record.workers.some(alive)) throw new Error("Scratch worker is still active");
}

async function cleanup(record, file, { dryRun } = {}) {
  assertCompleted(record);
  await checkRoot(record);
  const sealed = await verifyRelease(record.donor.releases, record.donor.id, record.donor.digest);
  const apply = dryRun === false || (dryRun === undefined && record.automatic);
  const removed = new Set(record.removed),
    eligible = [],
    retained = [];
  for (const [relative, entry] of Object.entries(record.entries)) {
    if (removed.has(relative)) continue;
    const target = await matches(record.scratchRoot, relative, entry.expected);
    if (!target || !equalIdentity(target, entry.identity)) {
      retained.push(relative);
      continue;
    }
    if (!(await matches(sealed.root, relative, entry.expected)))
      throw new Error("Verified restore copy changed");
    eligible.push(relative);
  }
  if (!apply) return { state: "planned", eligible, retained };
  if (!eligible.length && !record.removed.length)
    return { state: "completed", removed: [], retained };
  // Durable restore manifest precedes the first unlink. Only exact registered files are removed.
  record.state = "dependencies-pruned";
  await atomicJson(file, record);
  await writePrunedMarker(record, {
    schemaVersion: 1,
    registry: path.dirname(file),
    id: record.id,
    donor: record.donor,
    restoreOnlyMissing: true,
    restoreEntries: Object.fromEntries(
      Object.entries(record.entries).map(([relative, entry]) => [relative, entry.expected]),
    ),
  });
  const journal = `${file}.removed.jsonl`;
  try {
    for (const relative of eligible) {
      await checkRoot(record, relative);
      const entry = record.entries[relative],
        current = await matches(record.scratchRoot, relative, entry.expected);
      if (!current || !equalIdentity(current, entry.identity)) {
        retained.push(relative);
        continue;
      }
      if (!(await matches(sealed.root, relative, entry.expected)))
        throw new Error("Restore copy changed before unlink");
      await fs.unlink(path.join(record.scratchRoot, relative));
      record.removed.push(relative);
      await fs.appendFile(journal, JSON.stringify({ relative, restore: entry.expected }) + "\n", {
        mode: 0o600,
      });
    }
  } finally {
    await atomicJson(file, record);
  }
  return { state: record.state, removed: record.removed, retained };
}

/** Explicit completion may automatically reclaim exact copies while their owning task still holds its lease. */
export async function withDependencyScratchLease(input, operation) {
  return locked(input, async (record, file) => {
    if (
      record.state !== "active" ||
      record.ownerPid !== process.pid ||
      record.ownerInstance !== ownerInstance
    )
      throw new Error("Scratch lifecycle is not owned by this process");
    await checkRoot(record);
    let completed = false;
    const value = await operation({
      async recordWorker(pid) {
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
          throw new Error("Invalid child worker PID");
        if (!record.workers.includes(pid)) record.workers.push(pid);
        await atomicJson(file, record);
      },
      async complete() {
        if (record.workers.some(alive))
          throw new Error("Scratch children must exit before completion");
        await checkRoot(record);
        completed = true;
      },
    });
    if (!completed) return { value, cleanup: { state: "active" } };
    record.state = "completed";
    await atomicJson(file, record);
    return { value, cleanup: await cleanup(record, file) };
  });
}
export async function cleanupCompletedDependencies(input) {
  return locked(input, (record, file) => cleanup(record, file, input));
}
