import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isSameDaemonInstance, type DaemonInstance } from "@getpaseo/server/daemon-control";

function readPrivateRecord(directory: string, uid: number): unknown {
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== uid ||
    (directoryStat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(directory) !== path.resolve(directory)
  )
    return null;
  const filename = path.join(directory, "daemon-handoff.json");
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.uid !== uid || stat.size > 4096) return null;
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size > 4096
    )
      return null;
    const bytes = Buffer.alloc(4097);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 4096) return null;
    return JSON.parse(bytes.subarray(0, count).toString("utf8")) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}

function matchesInstance(captured: DaemonInstance, instance: DaemonInstance, uid: number): boolean {
  return (
    captured.desktopManaged === true &&
    captured.uid === uid &&
    captured.uid === instance.uid &&
    captured.hostname === instance.hostname &&
    captured.serverId === instance.serverId &&
    isSameDaemonInstance(captured, instance)
  );
}

/** Read only a private supervisor capability. Never derive ownership from an
 * endpoint or PID supplied in the environment. The live lock remains authoritative. */
interface DaemonHandoffInput {
  isPackaged: boolean;
  directory?: string;
  generation?: string;
  home: string;
  instance: DaemonInstance | null;
}

export function readDevUpdateDaemonHandoff(input: DaemonHandoffInput): DaemonInstance | null {
  const { directory, generation, home, instance } = input;
  if (
    input.isPackaged ||
    !directory ||
    !generation ||
    !path.isAbsolute(directory) ||
    !path.isAbsolute(home) ||
    !instance?.desktopManaged ||
    !process.getuid
  )
    return null;
  try {
    const uid = process.getuid();
    const value = readPrivateRecord(directory, uid);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      record.generation !== generation ||
      record.home !== path.resolve(home) ||
      !record.instance ||
      typeof record.instance !== "object"
    )
      return null;
    const captured = record.instance as DaemonInstance;
    if (!matchesInstance(captured, instance, uid)) return null;
    return instance;
  } catch {
    // Missing, stale, or malformed capabilities never confer ownership.
    return null;
  }
}

/** Called only after ownedLaunch has been assigned. A renderer-load receipt
 * alone cannot prove that this desktop accepted responsibility for the daemon. */
export function writeDevUpdateDaemonOwnership(input: DaemonHandoffInput): void {
  const instance = readDevUpdateDaemonHandoff(input);
  if (!instance || !input.directory)
    throw new Error("Daemon handoff changed before acknowledgement");
  const temporary = path.join(input.directory, `.daemon-owned-${randomUUID()}.tmp`);
  const destination = path.join(input.directory, "daemon-owned.json");
  let published = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(
        fd,
        `${JSON.stringify({
          schemaVersion: 1,
          generation: input.generation,
          home: path.resolve(input.home),
          instance,
        })}\n`,
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, destination);
    published = true;
    const directoryFd = fs.openSync(input.directory, "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (published) fs.unlinkSync(destination);
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
