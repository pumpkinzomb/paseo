#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  prepareDependencies,
  dependencyInputs,
  verifyDependencyEntries,
} from "./dev-update-dependencies.mjs";
import { inside, atomicJson } from "./dev-update-store.mjs";
const exec = promisify(execFile);
const overlaps = (a, b) => a === b || inside(a, b) || inside(b, a);
async function common(root) {
  const { stdout } = await exec(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root },
  );
  return fs.realpath(stdout.trim());
}
async function assertEmptyDependencies(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if ([".git", ".lab"].includes(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.name === "node_modules") {
      if (!entry.isDirectory() || (await fs.readdir(file)).length)
        throw new Error(
          "Existing dependencies need review; no installation or overwrite was attempted",
        );
    } else if (entry.isDirectory()) await assertEmptyDependencies(file);
  }
}
async function validateManagedTarget(env) {
  if (!env.PASEO_WORKTREE_DEPENDENCY_CONTEXT || !env.PASEO_WORKTREE_PATH)
    throw new Error(
      "Managed dependency context is required. Use Paseo's current managed runtime; automatic npm installation is disabled.",
    );
  const context = JSON.parse(env.PASEO_WORKTREE_DEPENDENCY_CONTEXT);
  const root = path.resolve(env.PASEO_WORKTREE_PATH);
  if (root !== (await fs.realpath(root))) throw new Error("Worktree path must not be an alias");
  if (
    !Array.isArray(context.protectedRoots) ||
    !context.protectedRoots.length ||
    !context.sourceRoot
  )
    throw new Error("Missing protected runtime or source roots");
  const source = await fs.realpath(context.sourceRoot);
  if (
    root === source ||
    !(await fs.lstat(path.join(root, ".git"))).isFile() ||
    (await common(root)) !== (await common(source))
  )
    throw new Error("Target must be a separate worktree of the managed source repository");
  for (const value of [...context.protectedRoots, context.releases]) {
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      overlaps(root, await fs.realpath(value))
    )
      throw new Error("Worktree overlaps protected runtime or state");
  }
  return { root, context };
}

export async function prepareManagedWorktree(env = process.env, dependencies = {}) {
  const prepare = dependencies.prepare ?? prepareDependencies;
  const { root, context } = await validateManagedTarget(env);
  const lock = await fs.open(path.join(root, ".managed-dependency-setup.lock"), "wx", 0o600);
  try {
    const receiptFile = path.join(root, ".managed-dependencies.json");
    let receipt;
    try {
      receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (receipt) {
      if (
        receipt.schemaVersion !== 1 ||
        receipt.root !== root ||
        JSON.stringify(receipt.inputs) !== JSON.stringify(await dependencyInputs(root))
      )
        throw new Error(
          "Managed dependency inputs changed; explicit dependency update is required",
        );
      await verifyDependencyEntries(root, receipt.entries);
      return { mode: "already-prepared", root };
    }
    await assertEmptyDependencies(root);
    const result = await prepare({
      source: root,
      releases: context.releases,
      donor: context.donor,
      allowInstall: false,
      minFreeBytes: 8 * 1024 ** 3,
    });
    if (result.mode !== "reuse")
      throw new Error("Managed worktrees require independent verified reuse");
    await atomicJson(receiptFile, {
      schemaVersion: 1,
      root,
      donor: result.donor,
      inputs: await dependencyInputs(root),
      entries: result.entries,
      preparedAt: new Date().toISOString(),
    });
    return { mode: result.mode, root };
  } finally {
    await lock.close();
    await fs.unlink(path.join(root, ".managed-dependency-setup.lock"));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareManagedWorktree()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
