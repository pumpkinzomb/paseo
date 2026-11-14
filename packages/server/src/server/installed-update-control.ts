import { isDeepStrictEqual } from "node:util";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface InstalledControlIdentity {
  uid: number;
  home: string;
  serverId: string;
  pid: number;
  startedAt: string;
  listen: string;
  version: string;
}
export interface UpdateControlPublication {
  assertAuthority(): Promise<void>;
  isActive(): boolean;
}
interface RegistrationSnapshot {
  bytes: string;
  dev: number;
  ino: number;
}
class PublicationDenied extends Error {}
async function privateDirectory(directory: string, uid: number) {
  const info = await lstat(directory);
  if (
    !path.isAbsolute(directory) ||
    (await realpath(directory)) !== directory ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o777) !== 0o700
  )
    throw new PublicationDenied("Unapproved installed control directory");
}
/** Read one private registration inode. It authorizes only this exact running daemon. */
async function registration(
  userHome: string,
  expected: InstalledControlIdentity,
): Promise<RegistrationSnapshot | null> {
  try {
    const root = path.join(userHome, ".paseo-installed");
    await privateDirectory(root, expected.uid);
    await privateDirectory(expected.home, expected.uid);
    const fd = await open(
      path.join(root, "daemon.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await fd.stat();
      if (
        !info.isFile() ||
        info.uid !== expected.uid ||
        (info.mode & 0o777) !== 0o600 ||
        info.nlink !== 1 ||
        info.size > 8192
      )
        return null;
      const bytes = await fd.readFile("utf8");
      const value = JSON.parse(bytes);
      if (
        Object.keys(value).sort().join() !==
          "approved,home,listen,pid,schemaVersion,serverId,startedAt,version" ||
        value.schemaVersion !== 1 ||
        value.approved !== true
      )
        return null;
      for (const key of ["home", "serverId", "pid", "startedAt", "listen", "version"] as const)
        if (value[key] !== expected[key]) return null;
      const url = new URL(`http://${value.listen}`);
      if (
        !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        !url.port ||
        url.host !== value.listen ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        return null;
      return { bytes, dev: info.dev, ino: info.ino };
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}
function same(left: RegistrationSnapshot | null, right: RegistrationSnapshot) {
  return left?.bytes === right.bytes && left.dev === right.dev && left.ino === right.ino;
}

async function assertCommittedHandoff(
  read: (name: string) => Promise<unknown>,
  directory: string,
  hold: { token: string; nextRevision: string; original: unknown },
) {
  const commit = z
    .object({ schemaVersion: z.literal(1), token: z.string(), revision: z.string() })
    .strict()
    .parse(await read("native-commit.json"));
  const stopped = z
    .object({ schemaVersion: z.literal(1), token: z.string(), original: z.unknown() })
    .strict()
    .parse(await read("stopped.json"));
  if (
    commit.token !== hold.token ||
    commit.revision !== hold.nextRevision ||
    stopped.token !== hold.token ||
    !isDeepStrictEqual(stopped.original, hold.original)
  )
    throw new Error("Official committed handoff evidence does not match");
  try {
    await lstat(path.join(directory, "handoff.lock"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Installed handoff is active or requires recovery");
}

/** Applied handoff evidence, never a staged offer or a caller-supplied revision. */
export async function readInstalledAppliedRevision(
  userHome: string,
  expected: InstalledControlIdentity,
) {
  const before = await registration(userHome, expected);
  if (!before) throw new Error("No exact approved installed daemon registration");
  const directory = path.join(userHome, ".paseo-installed", "daemon-update-v1");
  await privateDirectory(directory, expected.uid);
  async function read(name: string, from = directory) {
    const fd = await open(path.join(from, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await fd.stat();
      if (
        !info.isFile() ||
        info.uid !== expected.uid ||
        (info.mode & 0o777) !== 0o600 ||
        info.nlink !== 1 ||
        info.size > 8192
      )
        throw new Error("Untrusted installed handoff evidence");
      return JSON.parse(await fd.readFile("utf8"));
    } finally {
      await fd.close();
    }
  }
  const identity = z
    .object({
      uid: z.number().int(),
      home: z.string(),
      serverId: z.string(),
      pid: z.number().int(),
      startedAt: z.string(),
      listen: z.string(),
      version: z.string(),
    })
    .strict();
  const receipt = z
    .object({
      schemaVersion: z.literal(1),
      token: z.string(),
      revision: z.string().regex(/^[a-f0-9]{40}$/),
      instance: identity,
    })
    .strict()
    .parse(await read("receipt.json"));
  const hold = z
    .object({
      schemaVersion: z.literal(1),
      token: z.string(),
      oldRevision: z.string(),
      nextRevision: z.string(),
      nextVersion: z.string(),
      original: identity,
    })
    .strict()
    .parse(await read("hold.json"));
  await assertCommittedHandoff(read, directory, hold);
  const control = path.join(userHome, ".paseo-installed", "update-control");
  await privateDirectory(control, expected.uid);
  const descriptor = z
    .object({
      version: z.literal(1),
      workerPid: z.number().int().positive(),
      serverId: z.string(),
      instance: z.object({ pid: z.number(), startedAt: z.string(), uid: z.number() }).passthrough(),
      capabilities: z.object({ daemonCommit: z.literal(true) }).passthrough(),
    })
    .passthrough()
    .parse(await read("descriptor.json", control));
  if (
    descriptor.workerPid !== process.pid ||
    descriptor.serverId !== expected.serverId ||
    descriptor.instance.pid !== expected.pid ||
    descriptor.instance.startedAt !== expected.startedAt ||
    descriptor.instance.uid !== expected.uid
  )
    throw new Error("Applied release controller does not own this daemon worker");
  const sameIdentity = (
    ["uid", "home", "serverId", "pid", "startedAt", "listen", "version"] as const
  ).every((key) => receipt.instance[key] === expected[key]);
  const sameHost = (["uid", "home", "serverId", "listen"] as const).every(
    (key) => hold.original[key] === expected[key],
  );
  if (
    receipt.token !== hold.token ||
    receipt.revision !== hold.nextRevision ||
    hold.oldRevision === hold.nextRevision ||
    hold.nextVersion !== expected.version ||
    !sameIdentity ||
    !sameHost
  )
    throw new Error("Applied release receipt does not match this daemon instance");
  if (!same(await registration(userHome, expected), before))
    throw new Error("Installed daemon authority changed");
  return receipt.revision;
}

async function releasePublicationLock(lock: string, owned: Pick<Stats, "dev" | "ino" | "uid">) {
  const current = await lstat(lock).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (
    !current ||
    current.isSymbolicLink() ||
    current.dev !== owned.dev ||
    current.ino !== owned.ino ||
    current.uid !== owned.uid ||
    (current.mode & 0o777) !== 0o700
  )
    throw new PublicationDenied("Installed control publication lock changed");
  await rmdir(lock);
}

/** Provisioning and replacement can finish after startup. Observing authority never blocks readiness. */
export function observeInstalledUpdateControl(options: {
  userHome: string;
  expected: InstalledControlIdentity;
  ownsInstance(): Promise<boolean>;
  publish(guard: UpdateControlPublication): Promise<{ close(): Promise<void> }>;
  pollMs?: number;
  onError?: (error: unknown) => void;
}) {
  let closed = false;
  let active: { close(): Promise<void> } | null = null;
  let running: Promise<boolean> | null = null;
  const lock = path.join(options.userHome, ".paseo-installed", "provision.lock");
  async function attempt() {
    if (closed || active) return Boolean(active);
    const before = await registration(options.userHome, options.expected);
    if (
      !before ||
      !(await options.ownsInstance()) ||
      closed ||
      !same(await registration(options.userHome, options.expected), before)
    )
      return false;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    const owned = await lstat(lock);
    const guard: UpdateControlPublication = {
      isActive: () => !closed,
      assertAuthority: async () => {
        if (
          closed ||
          !(await options.ownsInstance()) ||
          closed ||
          !same(await registration(options.userHome, options.expected), before)
        )
          throw new PublicationDenied("Installed control authority changed");
        const current = await lstat(lock);
        if (
          closed ||
          current.isSymbolicLink() ||
          current.dev !== owned.dev ||
          current.ino !== owned.ino ||
          current.uid !== options.expected.uid ||
          (current.mode & 0o777) !== 0o700
        )
          throw new PublicationDenied("Installed control publication lock changed");
      },
    };
    let control: { close(): Promise<void> } | null = null;
    let failure: unknown;
    try {
      await guard.assertAuthority();
      control = await options.publish(guard);
      await guard.assertAuthority();
    } catch (error) {
      failure = error;
    }
    try {
      await releasePublicationLock(lock, owned);
    } catch (error) {
      failure ??= error;
    }
    if (failure || closed) {
      await control?.close();
      if (failure && !closed && !(failure instanceof PublicationDenied)) throw failure;
      return false;
    }
    active = control;
    return true;
  }
  function poll(): Promise<boolean> {
    if (closed) return Promise.resolve(false);
    if (!running)
      running = attempt().finally(() => {
        running = null;
      });
    return running;
  }
  const interval = options.pollMs ?? 1000;
  const timer =
    interval > 0
      ? setInterval(() => {
          void poll().catch(options.onError ?? (() => undefined));
        }, interval)
      : null;
  timer?.unref();
  if (timer) void poll().catch(options.onError ?? (() => undefined));
  return {
    poll,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await running?.catch(() => undefined);
      await active?.close();
    },
  };
}
