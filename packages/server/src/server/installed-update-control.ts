import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir } from "node:fs/promises";
import path from "node:path";

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
