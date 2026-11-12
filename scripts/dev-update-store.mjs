import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
// Bound I/O and memory while still reading every byte on every verification.
// Never use timestamps or a previous successful scan as content evidence.
export async function mapVerification(items, visit, concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("Invalid verification concurrency");
  const results = Array.from({ length: items.length });
  let next = 0;
  let failure;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await visit(items[index], index);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }),
  );
  // Drain in-flight reads before allowing callers to clean up or rename a tree.
  if (failed) throw failure;
  return results;
}
export async function hashFile(file) {
  const digest = crypto.createHash("sha256");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}
export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
export function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
export function assertId(id) {
  if (typeof id !== "string" || !idPattern.test(id))
    throw new Error("Invalid release or request ID");
  return id;
}
export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(
      `Control directory must be owned by this user with mode 0700: ${directory}`,
    );
  if ((await fs.realpath(directory)) !== path.resolve(directory))
    throw new Error("Control directory aliases are not allowed");
}
export async function acquireLock(directory, name, owner = {}) {
  const file = path.join(directory, name);
  let handle;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `Lock exists: ${file}. Never auto-clear it; verify the prior supervisor and children have exited before operator recovery.`,
        { cause: error },
      );
    throw error;
  }
  const token = crypto.randomUUID();
  await handle.writeFile(JSON.stringify({ token, pid: process.pid, ...owner }));
  await handle.sync();
  await handle.close();
  return async () => {
    if ((await readJson(file)).token !== token)
      throw new Error("Lock ownership changed");
    await fs.unlink(file);
  };
}
const mutable = (relative) =>
  relative === "release.json" ||
  relative === "packages/app/.expo" ||
  relative === "packages/app/expo-env.d.ts" ||
  relative === "node_modules/.cache";
// npm packages can install aliases as hardlinks (for example workerd). Break
// those links in the private staging tree, never by modifying a shared inode.
export async function detachStagingHardlinks(root) {
  let detached = 0;
  async function walk(directory) {
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name);
      const info = await fs.lstat(file);
      if (info.isDirectory()) await walk(file);
      else if (info.isFile() && info.nlink > 1) {
        const temporary = `${file}.independent-${crypto.randomUUID()}`;
        try {
          await fs.copyFile(
            file,
            temporary,
            constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
          );
          await fs.chmod(temporary, info.mode & 0o777);
          await fs.rename(temporary, file);
          detached++;
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
    }
  }
  await walk(root);
  return detached;
}

// Finder view metadata only; malformed or executable names remain sealed payload.
async function isFinderMetadata(file, info) {
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.mode & 0o111 ||
    info.size < 32 ||
    info.size > 1024 * 1024
  )
    return false;
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.nlink !== 1 ||
      current.size !== info.size ||
      current.mode & 0o111
    )
      return false;
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, 8, 0);
    return (
      bytesRead === 8 &&
      header.readUInt32BE(0) === 1 &&
      header.toString("ascii", 4, 8) === "Bud1"
    );
  } finally {
    await handle.close();
  }
}

export async function scanRelease(root) {
  const canonical = await fs.realpath(root);
  if (canonical !== path.resolve(root))
    throw new Error("Release root must not be an alias");
  const entries = {};
  async function walk(directory, prefix = "") {
    const children = await mapVerification(
      (await fs.readdir(directory)).sort(),
      async (name) => {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (mutable(relative)) return null;
        const file = path.join(directory, name);
        const info = await fs.lstat(file);
        if (name === ".DS_Store" && (await isFinderMetadata(file, info)))
          return null;
        if (info.isSymbolicLink()) {
          const target = await fs.readlink(file);
          if (
            path.isAbsolute(target) ||
            !inside(canonical, await fs.realpath(file))
          )
            throw new Error(`Release link escapes its tree: ${relative}`);
          return { relative, entry: { link: target } };
        } else if (info.isDirectory()) return { relative, directory: file };
        else if (info.isFile()) {
          if (info.nlink !== 1)
            throw new Error(
              `Shared hardlink is not a release file: ${relative}`,
            );
          return {
            relative,
            entry: {
              sha256: await hashFile(file),
              executable: Boolean(info.mode & 0o111),
            },
          };
        } else throw new Error(`Unsupported release entry: ${relative}`);
      },
    );
    // Preserve the original sorted depth-first manifest insertion order.
    // Recurse only after this batch drains, so nested directories cannot multiply concurrency.
    for (const child of children) {
      if (!child) continue;
      if (child.directory) await walk(child.directory, child.relative);
      else entries[child.relative] = child.entry;
    }
  }
  await walk(canonical);
  return entries;
}
export function manifestDigest(manifest) {
  return hash(JSON.stringify(manifest));
}
export async function verifyRelease(releases, id, expectedDigest) {
  assertId(id);
  const allowed = await fs.realpath(releases);
  const root = path.join(allowed, id);
  if (!inside(allowed, await fs.realpath(root)))
    throw new Error("Release escapes staging directory");
  const manifest = await readJson(path.join(root, "release.json"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== id ||
    manifest.stateCompatibility !== "preserve" ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceRevision)
  )
    throw new Error("Invalid release manifest");
  if (manifestDigest(manifest) !== expectedDigest)
    throw new Error("Release approval digest changed");
  const actualEntries = await scanRelease(root);
  if (JSON.stringify(actualEntries) !== JSON.stringify(manifest.entries)) {
    const changed = [
      ...new Set([
        ...Object.keys(manifest.entries ?? {}),
        ...Object.keys(actualEntries),
      ]),
    ].filter(
      (name) =>
        JSON.stringify(actualEntries[name]) !==
        JSON.stringify(manifest.entries?.[name]),
    );
    // Include bounded evidence, never file contents, so maintenance failures identify
    // which sealed release changed instead of leaving an unactionable generic skip.
    const details = changed.length
      ? `${changed.length} changed entries; ${JSON.stringify(changed.slice(0, 3)).slice(0, 240)}`
      : "manifest entry order differs";
    throw new Error(
      `Release contents changed after validation: ${id}; ${details}`,
    );
  }
  return { root, manifest };
}
const rendererPath = (file) =>
  /^(packages\/app\/(src|assets|dist)\/)/.test(file);
export function isRendererOnly(before, after) {
  // Metro config, package metadata, native/preload, all daemon/provider code and
  // every dependency must match. A change outside renderer files waits for quit.
  const paths = new Set([
    ...Object.keys(before.entries),
    ...Object.keys(after.entries),
  ]);
  for (const file of paths)
    if (
      !rendererPath(file) &&
      JSON.stringify(before.entries[file]) !==
        JSON.stringify(after.entries[file])
    )
      return false;
  return true;
}
export async function queueRelease(control, release) {
  await privateDirectory(control);
  const unlock = await acquireLock(control, "selection.lock");
  try {
    const state = await readJson(path.join(control, "state.json"));
    if (state.transition)
      throw new Error(
        "An interrupted update needs reconciliation before another can be queued",
      );
    if (
      state.pending &&
      (state.pending.id !== release.id ||
        state.pending.digest !== release.digest)
    )
      throw new Error("An update is already pending");
    if (
      state.current.id === release.id &&
      state.current.digest === release.digest
    )
      return state;
    state.pending = release;
    await atomicJson(path.join(control, "state.json"), state);
    return state;
  } finally {
    await unlock();
  }
}
export async function changeState(control, update) {
  const unlock = await acquireLock(control, "selection.lock");
  try {
    const file = path.join(control, "state.json");
    const state = await readJson(file);
    const next = await update(state);
    await atomicJson(file, next);
    return next;
  } finally {
    await unlock();
  }
}
