import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertId,
  atomicJson,
  acquireLock,
  privateDirectory,
  readJson,
} from "./dev-update-store.mjs";
const exec = promisify(execFile);
async function processInventory() {
  const ps = await exec("ps", ["-axo", "pid=,command="], { maxBuffer: 16 * 1024 ** 2 });
  // Command lines alone miss processes launched with a release as their cwd.
  const open = await exec("lsof", ["-a", "-u", String(process.getuid()), "-d", "cwd,txt", "-Fn"], {
    maxBuffer: 32 * 1024 ** 2,
  });
  return `${ps.stdout}\n${open.stdout}`;
}

async function canonical(root) {
  if (path.resolve(root) !== root || (await fs.realpath(root)) !== root)
    throw new Error("Prune roots must be canonical absolute paths, without symlinks");
  return root;
}
async function jsonFiles(root, visit, relative = "") {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (relative === "" && ["controller", "release-pruning"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Metadata alias refused: ${name}`);
    if (entry.isDirectory()) await jsonFiles(root, visit, name);
    else if (/\.(json|lock)$/.test(entry.name))
      await visit(name, await readJson(path.join(root, name)));
  }
}
async function bytes(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  let total = 0;
  for (const entry of await fs.readdir(root)) total += await bytes(path.join(root, entry));
  return total;
}
const strings = (value) => {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
};

/** Dry runs never create locks or receipts, including on the live controller. */
export async function pruneReleases(
  { control, releases, keep = 2, exclude = [], apply = false },
  deps = {},
) {
  await canonical(control);
  await canonical(releases);
  if (
    control === releases ||
    control.startsWith(`${releases}/`) ||
    releases.startsWith(`${control}/`)
  )
    throw new Error("Control and releases roots overlap");
  if (!Number.isSafeInteger(keep) || keep < 0)
    throw new Error("--keep must be a nonnegative integer");
  exclude.forEach(assertId);
  const processes = deps.processes ?? processInventory;
  const { candidates, skipped } = await releaseDirectories(releases);
  const retained = [],
    blocked = [];
  function references(value, reason, omit) {
    for (const raw of strings(value))
      for (const item of candidates)
        if (item.id !== omit && (raw === item.id || referencePath(raw, item.root)))
          if (!item.reasons.includes(reason)) item.reasons.push(reason);
  }
  const inspect = async (owned = false) => {
    const issues = [];
    // Required state/config must exist and parse before planning any deletion.
    const state = await readJson(path.join(control, "state.json"));
    const config = await readJson(path.join(control, "config.json"));
    if (config.releases !== releases) throw new Error("Configured releases root mismatch");
    if (state.transition) issues.push("selection transition in progress");
    await jsonFiles(control, async (name, value) => {
      references(value, `metadata:${name}`);
      if (["selection.lock", "release-prune.lock"].includes(name) && !owned)
        issues.push(`operation lock present:${name}`);
      if (name === "update-discovery.json" && value.cacheRoot) {
        await discoveryMetadata(value.cacheRoot, references, issues);
      }
      if (name.startsWith("managed-worktrees/") && value.root) {
        const receipt = path.join(value.root, ".managed-dependencies.json");
        const stat = await fs.lstat(receipt);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Managed receipt alias");
        references(await readJson(receipt), `managed-receipt:${value.root}`);
      }
      if (
        /(^|[-/_.])(lease|stage)([-/_.]|$)/i.test(name) ||
        (name.endsWith(".lock") &&
          ![
            "supervisor.lock",
            "discovery-watcher.lock",
            "selection.lock",
            "release-prune.lock",
          ].includes(name))
      )
        issues.push(`operation metadata present:${name}`);
      if (apply && ["supervisor.lock", "discovery-watcher.lock"].includes(name))
        issues.push(`stop controller/watcher before apply:${name}`);
      if (
        value &&
        typeof value === "object" &&
        [
          "active",
          "staging",
          "validating",
          "building",
          "checking",
          "updating",
          "prepared",
          "purging",
          "retired",
        ].includes(value.state)
      )
        issues.push(`operation in progress:${name}`);
    });
    const ps = await processes();
    for (const line of ps.split("\n")) {
      if (Number(line.trim().split(/\s+/)[0]) === process.pid) continue;
      if (
        /dev-update.*\s(stage|check-updates|watch-updates)\b|dev-update-full-stage|isolated-lab.*prepare-dependencies/.test(
          line,
        )
      )
        issues.push("runtime update process active");
      for (const item of candidates)
        if (line.includes(item.root) && !item.reasons.includes("running-process"))
          item.reasons.push("running-process");
    }
    return issues;
  };
  blocked.push(...(await inspect()));
  await retainDonors(candidates, references, exclude);
  for (const item of [...candidates]
    .sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id))
    .slice(0, keep))
    item.reasons.push(`recent:${keep}`);
  for (let offset = 0; offset < candidates.length; offset += 4) {
    await Promise.all(
      candidates.slice(offset, offset + 4).map(async (item) => {
        item.logicalBytes = await bytes(item.root);
      }),
    );
  }
  const eligible = [];
  for (const item of candidates) {
    delete item.modified;
    if (item.reasons.length) retained.push(item);
    else {
      item.reasons.push("unreferenced-outside-retention");
      eligible.push(item);
    }
  }
  const result = {
    schemaVersion: 1,
    dryRun: !apply,
    state: blocked.length ? "blocked" : "planned",
    blocked: [...new Set(blocked)],
    candidates: eligible,
    retained,
    skipped,
    estimatedLogicalBytes: blocked.length
      ? 0
      : eligible.reduce((sum, item) => sum + item.logicalBytes, 0),
    note: "Logical file bytes; shared APFS blocks mean actual free-space gains may be smaller.",
  };
  if (!apply || blocked.length) return result;
  // Apply is deliberately offline. Selection lock excludes queue mutations;
  // reinspection before each removal catches newly started controller operations.
  return applyPlan({ control, result, eligible, inspect, candidates, references });
}
async function applyPlan({ control, result, eligible, inspect, candidates, references }) {
  const unlock = await acquireLock(control, "release-prune.lock");
  let selectionUnlock;
  try {
    selectionUnlock = await acquireLock(control, "selection.lock");
    const registry = path.join(control, "release-pruning");
    await privateDirectory(registry);
    const journal = path.join(registry, `${crypto.randomUUID()}.json`);
    result.state = "deleting";
    await atomicJson(journal, result);
    try {
      for (const item of eligible) {
        const issues = await inspect(true);
        await retainDonors(candidates, references, []);
        if (
          issues.length ||
          item.reasons.some((reason) => reason !== "unreferenced-outside-retention")
        )
          throw new Error(`Prune evidence changed: ${issues.join(",")}`);
        await canonical(item.root);
        const stat = await fs.lstat(item.root);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.dev !== item.identity.dev ||
          stat.ino !== item.identity.ino
        )
          throw new Error("Release identity changed");
        item.state = "deleting";
        await atomicJson(journal, result);
        await fs.rm(item.root, { recursive: true });
        item.state = "deleted";
        await atomicJson(journal, result);
      }
      result.state = "completed";
    } catch (error) {
      result.state = "failed";
      result.error = error.message;
    }
    await atomicJson(journal, result);
    return result;
  } finally {
    await selectionUnlock?.();
    await unlock();
  }
}

async function releaseDirectories(releases) {
  const entries = await fs.readdir(releases, { withFileTypes: true });
  const candidates = [],
    skipped = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      skipped.push({ id: entry.name, reason: "not-a-real-directory" });
      continue;
    }
    assertId(entry.name);
    const root = path.join(releases, entry.name);
    await canonical(root);
    const stat = await fs.lstat(root);
    candidates.push({
      id: entry.name,
      root,
      reasons: [],
      identity: { dev: stat.dev, ino: stat.ino },
      modified: stat.mtimeMs,
    });
  }
  return { candidates, skipped };
}

async function retainDonors(candidates, references, exclude) {
  // Completed CoW releases are independent of their historical clone donor.
  // Recovery markers and managed receipts still need their restore donor.
  for (const item of candidates) {
    for (const name of [
      "release.json",
      ".dependencies-pruned.json",
      ".managed-dependencies.json",
    ]) {
      try {
        const file = path.join(item.root, name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error(`Release metadata alias:${file}`);
        const value = await readJson(file);
        if (name === "release.json" && value.dependencies) delete value.dependencies.donor;
        references(value, `release-reference:${item.id}/${name}`, item.id);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (exclude.includes(item.id)) item.reasons.push("explicit-exclude");
  }
}

async function discoveryMetadata(cacheRoot, references, issues) {
  await canonical(cacheRoot);
  for (const entry of await fs.readdir(cacheRoot)) {
    if (!/\.(json|lock)$/.test(entry)) continue;
    const file = path.join(cacheRoot, entry);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Discovery metadata alias");
    references(await readJson(file), `discovery-cache:${entry}`);
    if (entry.endsWith(".lock")) issues.push(`discovery operation:${entry}`);
  }
}

function referencePath(value, root) {
  if (!path.isAbsolute(value)) return false;
  const normalized = path.resolve(value);
  return normalized === root || normalized.startsWith(`${root}/`);
}
