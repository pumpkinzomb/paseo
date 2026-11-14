import {
  chmod,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
  lstat,
  readFile,
  open,
} from "node:fs/promises";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  lstatSync,
  readFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function applyPrivateMode(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(target, mode);
  } catch {
    // Permissions are not portable; creation must still work on such filesystems.
  }
}

export function ensurePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  applyPrivateMode(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(filePath: string): void {
  applyPrivateMode(filePath, PRIVATE_FILE_MODE);
}

export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const destination = resolveSymlinkedFile(filePath);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}`,
  );
  try {
    writeFileSync(temporary, data, { mode: PRIVATE_FILE_MODE });
    renameSync(temporary, destination);
    ensurePrivateFile(destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// Renaming onto a symlink replaces the link, so write to the file it points at.
function resolveSymlinkedFile(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return filePath;
    throw error;
  }
}

export async function ensurePrivateFileAsync(filePath: string): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(filePath, PRIVATE_FILE_MODE).catch(() => {});
}

export async function writePrivateFileAtomic(filePath: string, data: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== "win32") await chmod(directory, PRIVATE_DIRECTORY_MODE).catch(() => {});
  const destination = await realpath(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return filePath;
    throw error;
  });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}`,
  );
  try {
    await writeFile(temporary, data, { mode: PRIVATE_FILE_MODE });
    await rename(temporary, destination);
    await ensurePrivateFileAsync(destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Scoped durable revocation at the synchronous task admission boundary. */
export async function prepareTaskCompletionCancellations(root: string) {
  if (
    !path.isAbsolute(root) ||
    path.basename(root) !== "task-completion-cancellations" ||
    (await realpath(path.dirname(root))) !== path.dirname(root)
  )
    throw new Error("Cancellation markers require a canonical daemon-owned parent");
  const parent = await lstat(path.dirname(root));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.())
    throw new Error("Cancellation marker parent ownership changed");
  await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const parentDirectory = await open(path.dirname(root), "r");
  try {
    await parentDirectory.sync();
  } finally {
    await parentDirectory.close();
  }
  return loadTaskCompletionCancellations(root);
}

export async function loadTaskCompletionCancellations(root: string) {
  if (!path.isAbsolute(root) || path.basename(root) !== "task-completion-cancellations")
    throw new Error("Expected task completion marker directory");
  const identity = await lstat(root);
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== process.getuid?.() ||
    identity.mode & 0o077 ||
    (await realpath(root)) !== root
  )
    throw new Error("Unsafe task completion cancellation directory");
  const contents = "Completion invalidated by new work\n";
  function file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid task completion identity");
    return path.join(root, id);
  }
  function validate(info: typeof identity) {
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== identity.uid ||
      info.mode & 0o077
    )
      throw new Error("Unsafe task completion cancellation marker");
  }
  return {
    async has(id: string) {
      try {
        const target = file(id);
        validate(await lstat(target));
        if ((await readFile(target, "utf8")) !== contents)
          throw new Error("Unknown cancellation marker");
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    },
    cancel(id: string) {
      const current = lstatSync(root);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        realpathSync(root) !== root ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.uid !== identity.uid ||
        current.mode & 0o077
      )
        throw new Error("Cancellation directory identity changed");
      const target = file(id);
      try {
        validate(lstatSync(target));
        if (readFileSync(target, "utf8") !== contents)
          throw new Error("Unknown cancellation marker");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const temporary = path.join(root, `.${id}.${randomUUID()}`);
        try {
          writeFileSync(temporary, contents, { mode: PRIVATE_FILE_MODE, flag: "wx", flush: true });
          // Rename replaces a concurrently inserted symlink; its target is never followed.
          renameSync(temporary, target);
        } catch (writeError) {
          rmSync(temporary, { force: true });
          throw writeError;
        }
      }
      // Also flush an existing marker: a prior directory flush may have failed.
      const directory = openSync(root, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    },
  };
}
