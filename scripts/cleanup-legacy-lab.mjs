#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hash, privateDirectory, verifyRelease, inside } from "./dev-update-store.mjs";
import {
  dependencyRootsIn,
  reclaimStoppedBuildDependencies,
  processesUsing,
} from "./stopped-build-dependencies.mjs";

// Legacy lab copies predate the managed worktree registry. Adoption is explicit,
// never based on age, file names, completion labels or a recursive delete.
export async function cleanupLegacyLab(
  { lab, candidate, control, donor, apply = false },
  deps = {},
) {
  for (const root of [lab, control]) {
    if (!path.isAbsolute(root) || (await fs.realpath(root)) !== root)
      throw new Error("Legacy lab paths must be canonical");
  }
  if (!candidate || candidate === "." || candidate === ".." || /[/\\]/.test(candidate))
    throw new Error("Select one direct .lab child");
  const managedRoot = path.join(lab, ".lab"),
    scratchRoot = path.join(managedRoot, candidate);
  for (const root of [managedRoot, scratchRoot]) {
    const stat = await fs.lstat(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(root)) !== root ||
      stat.uid !== process.getuid()
    )
      throw new Error("Legacy candidate is not an owned directory");
  }
  const roots = await dependencyRootsIn(scratchRoot);
  if (!apply)
    return { state: "planned", root: scratchRoot, dependencyRoots: roots, sourcePreserved: true };
  if (!roots.length) return { state: "nothing-to-reclaim", root: scratchRoot };
  await verifyRelease(donor.releases, donor.id, donor.digest);
  for (const protectedRoot of [control, await fs.realpath(donor.releases)])
    if (
      protectedRoot === scratchRoot ||
      inside(protectedRoot, scratchRoot) ||
      inside(scratchRoot, protectedRoot)
    )
      throw new Error("Legacy candidate overlaps protected state");
  const active = deps.active ?? processesUsing;
  if (await active(scratchRoot)) return { state: "retained", reason: "process-using-build" };
  // Limit access to this explicitly adopted scratch and its parent before
  // registering exact donor copies. Never change live source file permissions.
  for (const root of [managedRoot, scratchRoot]) await fs.chmod(root, 0o700);
  const registry = path.join(control, "legacy-lab-cleanup", hash(scratchRoot));
  await privateDirectory(registry);
  return reclaimStoppedBuildDependencies(
    {
      registry,
      managedRoot,
      scratchRoot,
      donor,
      protectedPaths: [control, donor.releases],
    },
    { active },
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") options.apply = true;
    else if (args[i].startsWith("--") && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error("Use --lab --candidate --control --releases --donor --digest [--apply]");
  }
  cleanupLegacyLab({
    ...options,
    donor: { releases: options.releases, id: options.donor, digest: options.digest },
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
