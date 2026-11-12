import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerDependencyScratch, withDependencyScratchLease } from "./dev-update-cleanup.mjs";
const exec = promisify(execFile);

export async function dependencyRootsIn(root, relative = "") {
  const roots = [];
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!item.isDirectory() || [".git", ".lab"].includes(item.name)) continue;
    const name = path.join(relative, item.name);
    if (item.name === "node_modules") roots.push(name);
    else roots.push(...(await dependencyRootsIn(root, name)));
  }
  return roots;
}
export async function processesUsing(root) {
  const [{ stdout: commands }, { stdout: files }] = await Promise.all([
    exec("ps", ["-axo", "pid=,command="], { maxBuffer: 16 * 1024 ** 2 }),
    exec("lsof", ["-a", "-u", String(process.getuid()), "-d", "cwd,txt", "-Fpn"], {
      maxBuffer: 32 * 1024 ** 2,
    }),
  ]);
  let pid;
  for (const line of files.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (
      pid !== process.pid &&
      line.startsWith("n") &&
      (line.slice(1) === root || line.slice(1).startsWith(`${root}/`))
    )
      return true;
  }
  return commands
    .split("\n")
    .some((line) => Number(line.trim().split(/\s+/)[0]) !== process.pid && line.includes(root));
}

// Caller must own a stopped private build, or explicitly adopt a legacy .lab child.
// Only byte-identical dependency copies backed by a sealed donor are reclaimed.
export async function reclaimStoppedBuildDependencies(input, { active = processesUsing } = {}) {
  const roots = await dependencyRootsIn(input.scratchRoot);
  if (!roots.length) return { state: "nothing-to-reclaim" };
  if (await active(input.scratchRoot)) return { state: "retained", reason: "process-using-build" };
  const record = await registerDependencyScratch({
    ...input,
    dependencyRoots: roots,
    automatic: true,
  });
  const result = await withDependencyScratchLease(record, async (lease) => {
    if (await active(input.scratchRoot))
      throw new Error("Build became active; dependencies retained");
    await lease.complete();
  });
  return { ...result.cleanup, record };
}
