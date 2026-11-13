import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readRegisteredDaemon, type RegisteredDaemon } from "../profile/registered-daemon.js";
import {
  createHandoffStore,
  validateExactDaemonUpdate,
  type HandoffIdentity,
  type HandoffReceipt,
  type ExactDaemonUpdate,
} from "./installed-daemon-handoff.js";

const metadata = {
  paseoDistribution: { schemaVersion: 1, channel: "local", updatePolicy: "local-only" },
};
function record(identity: HandoffIdentity): RegisteredDaemon {
  const { uid: _uid, ...fields } = identity;
  return { schemaVersion: 1, approved: true, ...fields };
}
function matches(a: RegisteredDaemon, b: RegisteredDaemon) {
  return Object.keys(b).every(
    (key) => a[key as keyof RegisteredDaemon] === b[key as keyof RegisteredDaemon],
  );
}
async function syncDir(root: string) {
  const handle = await open(root, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function privateFile(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 8192
    )
      throw Error("Untrusted CAS file");
    return { stat, bytes: await handle.readFile("utf8") };
  } finally {
    await handle.close();
  }
}
async function exclusiveWrite(file: string, bytes: string) {
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function validateReceipt(capability: ExactDaemonUpdate, receipt: HandoffReceipt) {
  validateExactDaemonUpdate(capability);
  const result = receipt.instance,
    original = capability.original;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.token !== capability.token ||
    ![capability.oldRevision, capability.nextRevision].includes(receipt.revision) ||
    original.uid !== process.getuid!() ||
    result.uid !== original.uid ||
    result.home !== original.home ||
    result.serverId !== original.serverId ||
    result.listen !== original.listen ||
    !Number.isSafeInteger(result.pid) ||
    result.pid <= 0 ||
    !result.startedAt ||
    (result.pid === original.pid && result.startedAt === original.startedAt) ||
    result.version !==
      (receipt.revision === capability.nextRevision ? capability.nextVersion : original.version)
  )
    throw Error("Invalid exact CAS receipt");
}

/** No production wiring. Same cooperative lock as the official provisioning CLI. */
export async function refreshInstalledRegistration(
  userHome: string,
  capability: ExactDaemonUpdate,
  receipt: HandoffReceipt,
): Promise<void> {
  validateReceipt(capability, receipt);
  const store = await createHandoffStore(userHome, process.getuid!());
  if (
    JSON.stringify(await store.read("hold")) !== JSON.stringify(capability) ||
    JSON.stringify(await store.read("receipt")) !== JSON.stringify(receipt)
  )
    throw Error("Durable handoff evidence mismatch");
  const root = path.join(userHome, ".paseo-installed");
  const lock = path.join(root, "provision.lock");
  await mkdir(lock, { mode: 0o700 }); // Never reclaim interrupted or foreign locks.
  await syncDir(root);
  const owned = await lstat(lock);
  const file = path.join(root, "daemon.json");
  const temporary = path.join(root, `.daemon-update-${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const before = await privateFile(file);
    const current = readRegisteredDaemon({
      packaged: true,
      metadata,
      userHome,
      version: capability.original.version,
    });
    if (!current || !matches(current, record(capability.original)))
      throw Error("Registration CAS conflict");
    // Immutable preimage, scoped to the existing single handoff. Never auto-restore.
    const preimage = path.join(root, "daemon-update-v1", "registration-preimage.json");
    try {
      await exclusiveWrite(preimage, before.bytes);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await privateFile(preimage)).bytes !== before.bytes
      )
        throw error;
    }
    await syncDir(path.dirname(preimage));
    await exclusiveWrite(temporary, JSON.stringify(record(receipt.instance)));
    temporaryExists = true;
    const check = await privateFile(file);
    if (
      check.stat.dev !== before.stat.dev ||
      check.stat.ino !== before.stat.ino ||
      check.bytes !== before.bytes
    )
      throw Error("Registration changed before CAS");
    const locked = await lstat(lock);
    if (locked.isSymbolicLink() || locked.dev !== owned.dev || locked.ino !== owned.ino)
      throw Error("CAS lock ownership changed");
    await rename(temporary, file);
    temporaryExists = false;
    await syncDir(root);
    const verified = readRegisteredDaemon({
      packaged: true,
      metadata,
      userHome,
      version: receipt.instance.version,
    });
    if (!verified || !matches(verified, record(receipt.instance)))
      throw Error("Registration replacement verification failed");
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
  }
  // Failure skips this block and retains the lock/preimage for explicit recovery.
  const locked = await lstat(lock);
  if (locked.dev !== owned.dev || locked.ino !== owned.ino || locked.isSymbolicLink())
    throw Error("CAS lock ownership changed");
  await rmdir(lock);
  await syncDir(root);
}
