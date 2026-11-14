import { PrecommitUpdateRejected } from "./precommit-rejected.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, rmdir } from "node:fs/promises";
import path from "node:path";
import { readRegisteredDaemon } from "../profile/registered-daemon.js";
import {
  createHandoffStore,
  runExactDaemonHandoff,
  validateExactDaemonUpdate,
} from "./installed-daemon-handoff.js";
import { refreshInstalledRegistration } from "./installed-registration-cas.js";
import type { ApprovedHandoffHost } from "./installed-handoff-host.js";

async function sync(directory: string) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Only trusted main calls this after validating the signed running bundle,
 * exact user-approved candidate and persisted registration. Never renderer IPC input. */
async function context(host: ApprovedHandoffHost) {
  validateExactDaemonUpdate(host.capability);
  await host.verifyApproval();
  const store = await createHandoffStore(host.userHome, process.getuid!());
  const directory = path.join(host.userHome, ".paseo-installed", "daemon-update-v1");
  const lock = path.join(directory, "handoff.lock");
  await mkdir(lock, { mode: 0o700 });
  await sync(directory);
  const owned = await lstat(lock);
  return {
    store,
    async release() {
      const current = await lstat(lock);
      if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino)
        throw Error("Handoff lock changed");
      await rmdir(lock);
      await sync(directory);
    },
  };
}
function readRegistration(host: ApprovedHandoffHost, version: string) {
  const registration = readRegisteredDaemon({
    packaged: true,
    userHome: host.userHome,
    version,
    metadata: {
      paseoDistribution: { schemaVersion: 1, channel: "local", updatePolicy: "local-only" },
    },
  });
  if (!registration) throw Error("Missing installed registration");
  const { schemaVersion: _schema, approved: _approved, ...fields } = registration;
  return { uid: process.getuid!(), ...fields };
}
function sameOriginal(host: ApprovedHandoffHost) {
  const actual = readRegistration(host, host.capability.original.version);
  if (
    Object.keys(host.capability.original).some(
      (k) =>
        actual[k as keyof typeof actual] !== host.capability.original[k as keyof typeof actual],
    )
  )
    throw Error("Registration changed before handoff");
}
/** Phase 1: old signed app persists a stop receipt; no replacement or new start.
 * Any uncertain failure retains handoff.lock for explicit recovery. */
export async function prepareInstalledReplacement(host: ApprovedHandoffHost) {
  if (host.runningRevision !== host.capability.oldRevision)
    throw Error("Old signed revision required");
  const { store, release } = await context(host);
  let stopAttempted = false;
  let admissionAttempted = false;
  try {
    sameOriginal(host);
    if (
      (await store.read("hold")) ||
      (await store.read("stopped")) ||
      (await store.read("receipt"))
    )
      throw Error("Existing handoff requires recovery");
    const original = host.capability.original;
    const live = await host.readExactInstance();
    if (
      !live ||
      Object.keys(original).some(
        (k) => live[k as keyof typeof live] !== original[k as keyof typeof original],
      )
    )
      throw Error("Original instance changed");
    admissionAttempted = true;
    await host.verifyAdmission();
    stopAttempted = true;
    await host.stopAfterDurablePrepare(original, async () => {
      sameOriginal(host);
      await host.verifyApproval();
      await store.write("hold", host.capability);
    });
    if (await host.readExactInstance()) throw Error("Stop not verified");
    sameOriginal(host);
    await store.write("stopped", { schemaVersion: 1, token: host.capability.token, original });
    await release();
  } catch (error) {
    // Rejection before invoking stop has no irreversible side effects. Only
    // release the exact lock we acquired, and only with no durable stop markers.
    if (
      !stopAttempted &&
      !(await store.read("hold")) &&
      !(await store.read("stopped")) &&
      !(await store.read("receipt"))
    ) {
      await release();
      if (admissionAttempted) throw new PrecommitUpdateRejected(error);
      throw error;
    }
    throw error;
  }
  return { state: "stopped-for-replacement" as const };
}
/** Phase 2: new signed app (or explicitly verified old recovery build) startup.
 * A stop receipt is not authority to adopt any unexpected live process. */
export async function resumeInstalledReplacement(host: ApprovedHandoffHost) {
  const c = host.capability;
  if (![c.nextRevision, c.oldRevision].includes(host.runningRevision))
    throw Error("Unapproved startup revision");
  const { store, release } = await context(host);
  if (
    !equal(await store.read("hold"), c) ||
    !equal(await store.read("stopped"), { schemaVersion: 1, token: c.token, original: c.original })
  )
    throw Error("Verified stopped handoff missing");
  const receipt = await runExactDaemonHandoff(c, host.runningRevision, store, {
    exclusive: (operation) => operation(),
    verifyApproval: () => host.verifyApproval(),
    verifyAdmission: async () => {
      if (await host.readExactInstance()) throw Error("Unexpected live daemon at startup");
    },
    readRegistration: async () => {
      try {
        return readRegistration(host, c.original.version);
      } catch {
        return readRegistration(host, c.nextVersion);
      }
    },
    readInstance: () => host.readExactInstance(),
    stopOfficial: async () => {
      throw Error("Startup cannot stop a daemon");
    },
    startOfficial: (revision, original) => host.startApprovedRevision(revision, original),
    refreshRegistration: (_expected, value) =>
      refreshInstalledRegistration(host.userHome, c, value),
  });
  await release();
  return receipt;
}
