import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

export interface TaskArtifactOwner {
  cwd: string;
  workspaceId: string;
}
const parentName = ".paseo-task-artifacts";
const ownerName = ".paseo-owner.json";
async function location(owner: TaskArtifactOwner) {
  if (!owner.workspaceId.trim() || owner.workspaceId.length > 256)
    throw Error("Task artifacts require a workspace identity");
  const root = await realpath(owner.cwd);
  const parent = path.join(root, parentName);
  const directory = path.join(parent, createHash("sha256").update(owner.workspaceId).digest("hex"));
  return { root, parent, directory, marker: { version: 1, workspaceId: owner.workspaceId, root } };
}
async function realDirectory(directory: string) {
  const s = await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink() || (await realpath(directory)) !== directory)
    throw Error("Task artifact directory must not redirect to another location");
}
async function verifyMarker(directory: string, expected: object) {
  const f = await open(path.join(directory, ownerName), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.size > 4096 ||
      (process.getuid && s.uid !== process.getuid())
    )
      throw Error("Invalid task artifact ownership file");
    if (JSON.stringify(JSON.parse(await f.readFile("utf8"))) !== JSON.stringify(expected))
      throw Error("Task artifact ownership changed");
  } finally {
    await f.close();
  }
}
/** No arbitrary output path: every workspace has its own marked child of its recorded cwd. */
export async function prepareTaskArtifactDirectory(owner: TaskArtifactOwner): Promise<string> {
  const { parent, directory, marker } = await location(owner);
  await mkdir(parent, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  await realDirectory(parent);
  let created = true;
  await mkdir(directory, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
    created = false;
  });
  await realDirectory(directory);
  if (created) {
    const f = await open(
      path.join(directory, ownerName),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await f.writeFile(JSON.stringify(marker));
      await f.sync();
    } finally {
      await f.close();
    }
  }
  await verifyMarker(directory, marker);
  return directory;
}
async function validateTree(directory: string): Promise<void> {
  await realDirectory(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const s = await lstat(target);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || (s.isFile() && s.nlink !== 1))
      throw Error("Task artifacts contain a shared, linked or unsupported file; review cleanup");
    if (s.isDirectory()) await validateTree(target);
  }
}
/** Inspection is read-only; absence is valid, unowned/linked trees fail closed. */
export async function inspectTaskArtifacts(owner: TaskArtifactOwner): Promise<string | null> {
  let target: Awaited<ReturnType<typeof location>>;
  try {
    target = await location(owner);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const { parent, directory, marker } = target;
  try {
    await lstat(parent);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  await realDirectory(parent);
  try {
    await lstat(directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  await realDirectory(directory);
  await verifyMarker(directory, marker);
  await validateTree(directory);
  return directory;
}
/** Call only after the complete workspace scope is locked, idle and confirmed for deletion. */
export async function removeTaskArtifacts(owner: TaskArtifactOwner): Promise<void> {
  const directory = await inspectTaskArtifacts(owner);
  if (directory) await rm(directory, { recursive: true });
  // Never remove the shared parent, legacy artifacts, source, worktrees or credentials.
}
