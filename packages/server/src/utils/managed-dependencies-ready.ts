import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const pending = new Map<string, Promise<void>>();
const receiptRoots = new Map<string, string | null>();
/** Provider creation already discovers the boundary; ordinary turns retain synchronous startup. */
export function needsManagedDependencyCheck(cwd: string): boolean {
  return receiptRoots.get(resolve(cwd)) !== null;
}
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
async function findReceipt(cwd: string): Promise<string | null> {
  if (!isAbsolute(cwd)) return null;
  let current = resolve(cwd);
  for (let depth = 0; depth < 64 && dirname(current) !== current; depth++) {
    try {
      await lstat(join(current, ".managed-dependencies.json"));
      return current;
    } catch (error) {
      if (!absent(error)) throw error;
    }
    try {
      await lstat(join(current, ".git"));
      return null; // Never adopt a receipt belonging to a containing repository.
    } catch (error) {
      if (!absent(error)) throw error;
    }
    current = dirname(current);
  }
  return null;
}
async function receiptAt(
  root: string,
): Promise<{ schemaVersion?: number; root?: string; state?: string }> {
  const file = join(root, ".managed-dependencies.json");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Managed dependency receipt must be a regular file");
  return JSON.parse(await readFile(file, "utf8"));
}
/** Recreate only explicitly reclaimed managed dependencies; never install or rebuild. */
export async function ensureManagedDependenciesReady(
  cwd: string,
  options: {
    purpose?: "history" | "interactive";
    env?: NodeJS.ProcessEnv;
    runHelper?: (helper: string, env: NodeJS.ProcessEnv) => Promise<void>;
  } = {},
): Promise<void> {
  if (options.purpose === "history") return;
  const root = await findReceipt(cwd);
  receiptRoots.set(resolve(cwd), root);
  if (!root) return;
  if ((await realpath(cwd)) !== resolve(cwd) || (await realpath(root)) !== root)
    throw new Error("Managed worktree paths must not use symbolic aliases");
  const receipt = await receiptAt(root);
  if (receipt.schemaVersion !== 1 || receipt.root !== root)
    throw new Error("Invalid managed dependency receipt");
  if (receipt.state === undefined || receipt.state === "prepared") return;
  if (receipt.state !== "retired")
    throw new Error("Managed dependency recovery is required before execution");
  const existing = pending.get(root);
  if (existing) return existing;
  const task = (async () => {
    const env = options.env ?? process.env;
    const helper = env.PASEO_WORKTREE_SETUP_HELPER;
    if (!helper || !isAbsolute(helper) || !env.PASEO_WORKTREE_DEPENDENCY_CONTEXT)
      throw new Error(
        "Managed dependencies were reclaimed; a trusted dependency donor is required to resume",
      );
    const helperStat = await lstat(helper);
    if (!helperStat.isFile() || helperStat.isSymbolicLink() || (await realpath(helper)) !== helper)
      throw new Error("Managed dependency helper must be a canonical regular file");
    const childEnv = { ...env, PASEO_WORKTREE_PATH: root };
    if (options.runHelper) await options.runHelper(helper, childEnv);
    else
      await exec(process.execPath, [helper], {
        cwd: root,
        env: childEnv,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
    const restored = await receiptAt(root);
    if (
      restored.schemaVersion !== 1 ||
      restored.root !== root ||
      (restored.state !== undefined && restored.state !== "prepared")
    )
      throw new Error("Managed dependency restoration did not finish; session start was blocked");
  })();
  pending.set(root, task);
  try {
    await task;
  } finally {
    if (pending.get(root) === task) pending.delete(root);
  }
}
