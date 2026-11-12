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
    `For changes to Paseo itself, use the independent development checkout ${JSON.stringify(
      policy.labRoot,
    )} as the source baseline. For delegated agents, create each editing subtask in a separate managed branch/worktree; do not have multiple agents edit the shared lab. Keep builds and tests in that task checkout.`,
    `During autonomous development, do not edit, build, install dependencies, restart, terminate or replace the running Paseo or these protected paths: ${JSON.stringify(
      policy.protectedRoots,
    )}. Do not change live data/auth or runtime-control launchers.`,
    "Other user projects remain allowed. Do not reinterpret unrelated work as Paseo development. When resuming in a protected cwd, inspect only and delegate any Paseo edits to the lab; never silently change a native session's cwd.",
    "Use the lab launcher for isolated ports/data/output. This boundary is not permission to bypass denied tools, approval or isolation checks.",
    "These are workflow defaults for autonomous development. Follow the user's explicit instructions and intended outcome; do not reject a request solely because your own default workflow prefers a different approach.",
    "For an explicit operational request such as restart, first check the actual running work and saved state, then use the supported operational path. If there is a concrete risk, explain exactly which work, unsaved input or connection would be interrupted and obtain only any missing decision or required approval. Do not replace this assessment with a blanket 'blocked by policy' refusal.",
    "An explicit restart request authorizes a normal restart, not unrelated changes, discarded work or forced termination of unknown processes. Tool permissions, actual access denials and required safety checks still apply; never bypass them or claim uncertain state is safe.",
    "Report tested changes for promotion. Autonomous deployment/rollback requires explicit approval, complete work checks and verified rollback. User-directed operations are evaluated separately against their concrete scope and effects, rather than rejected by this autonomous default.",
  ].join("\n");
}
