import { realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename, join, sep } from "node:path";
import { homedir } from "node:os";

// Workflow guard, NOT a shell/OS sandbox. Never changes a resumed session's cwd.
export interface SelfDevelopmentPolicy {
  labRoot: string;
  protectedRoots: string[];
}
async function canonical(input: string): Promise<string> {
  let expanded = input;
  if (input === "~") expanded = homedir();
  else if (input.startsWith("~/")) expanded = join(homedir(), input.slice(2));
  let target = resolve(expanded);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(target), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(target);
      if (parent === target) throw error;
      missing.unshift(basename(target));
      target = parent;
    }
  }
}
function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export async function readSelfDevelopmentPolicy(
  raw: string | undefined,
): Promise<SelfDevelopmentPolicy | undefined> {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as SelfDevelopmentPolicy;
  if (
    !value ||
    typeof value.labRoot !== "string" ||
    !isAbsolute(value.labRoot) ||
    !Array.isArray(value.protectedRoots) ||
    value.protectedRoots.length === 0 ||
    value.protectedRoots.some((root) => typeof root !== "string" || !isAbsolute(root))
  ) {
    throw new Error("Invalid PASEO_SELF_DEVELOPMENT_POLICY");
  }
  const labRoot = await canonical(value.labRoot);
  const protectedRoots = await Promise.all(value.protectedRoots.map(canonical));
  if (
    !(await stat(labRoot)).isDirectory() ||
    protectedRoots.some((root) => contains(root, labRoot) || contains(labRoot, root))
  ) {
    throw new Error("Self-development lab overlaps protected roots or does not exist");
  }
  return { labRoot, protectedRoots };
}
export async function assertSelfDevelopmentCwd(
  policy: SelfDevelopmentPolicy | undefined,
  cwd: string,
): Promise<void> {
  if (!policy) return;
  const target = await canonical(cwd);
  if (policy.protectedRoots.some((root) => contains(root, target))) {
    throw new Error(
      `Cannot create an agent in a protected Paseo runtime/source. Use ${policy.labRoot} for Paseo development. Other projects remain allowed.`,
    );
  }
}
export function selfDevelopmentPrompt(policy: SelfDevelopmentPolicy | undefined): string {
  if (!policy) return "";
  return [
    "Paseo self-development boundary (workflow guidance, not an OS sandbox):",
    `For changes to Paseo itself, use only the independent development checkout ${JSON.stringify(
      policy.labRoot,
    )}, including delegated agents, builds and tests.`,
    `Do not edit, build, install dependencies, restart, terminate or replace the running Paseo or these protected paths: ${JSON.stringify(
      policy.protectedRoots,
    )}. Do not change live data/auth or runtime-control launchers.`,
    "Other user projects remain allowed. Do not reinterpret unrelated work as Paseo development. When resuming in a protected cwd, inspect only and delegate any Paseo edits to the lab; never silently change a native session's cwd.",
    "Use the lab launcher for isolated ports/data/output. This boundary is not permission to bypass denied tools, approval or isolation checks.",
    "Report tested changes for promotion. Runtime deployment/rollback is a separate operator action after explicit approval, idle checks and a verified rollback; never deploy or restart yourself.",
  ].join("\n");
}
