import { lstat, mkdir, open, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readRegisteredDaemon } from "../profile/registered-daemon.js";
import {
  createHandoffStore,
  runExactDaemonHandoff,
  type ExactDaemonUpdate,
  type HandoffIdentity,
} from "./installed-daemon-handoff.js";
import { refreshInstalledRegistration } from "./installed-registration-cas.js";

export interface ApprovedHandoffHost {
  /** Trusted OS home and verified main-owned capability; never IPC request data. */
  userHome: string;
  capability: ExactDaemonUpdate;
  runningRevision: string;
  verifyApproval(): Promise<void>;
  verifyAdmission(): Promise<void>;
  readExactInstance(): Promise<HandoffIdentity | null>;
  /** Bind to daemon-mode commitToShutdown(ticket, durablePrepare) only. */
  stopAfterDurablePrepare(
    expected: HandoffIdentity,
    durablePrepare: () => Promise<void>,
  ): Promise<void>;
  startApprovedRevision(revision: string, original: HandoffIdentity): Promise<HandoffIdentity>;
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Inactive composition. No IPC registration, process launch or default host adapters. */
export async function runInstalledHandoffHost(host: ApprovedHandoffHost) {
  await host.verifyApproval();
  const c = host.capability;
  const store = await createHandoffStore(host.userHome, process.getuid!());
  const directory = path.join(host.userHome, ".paseo-installed", "daemon-update-v1");
  const lock = path.join(directory, "handoff.lock");
  await mkdir(lock, { mode: 0o700 });
  await syncDirectory(directory);
  const owned = await lstat(lock);
  // Errors intentionally retain the whole-run lock. Never reclaim by PID/liveness.
  const receipt = await runExactDaemonHandoff(c, host.runningRevision, store, {
    exclusive: async (operation) => operation(), // Fixed filesystem lock is already held.
    verifyApproval: async () => host.verifyApproval(),
    verifyAdmission: async () => host.verifyAdmission(),
    readRegistration: async () => {
      const metadata = {
        paseoDistribution: { schemaVersion: 1, channel: "local", updatePolicy: "local-only" },
      };
      // Read version from the immutable current-or-new receipt binding, never arbitrary input.
      let value;
      try {
        value = readRegisteredDaemon({
          packaged: true,
          metadata,
          userHome: host.userHome,
          version: c.original.version,
        });
      } catch {
        value = readRegisteredDaemon({
          packaged: true,
          metadata,
          userHome: host.userHome,
          version: c.nextVersion,
        });
      }
      if (!value) throw Error("Missing registered daemon");
      const { schemaVersion: _schema, approved: _approved, ...fields } = value;
      return { uid: process.getuid!(), ...fields };
    },
    readInstance: () => host.readExactInstance(),
    stopOfficial: (expected) =>
      host.stopAfterDurablePrepare(expected, async () => {
        if (JSON.stringify(await store.read("hold")) !== JSON.stringify(c))
          throw Error("Durable hold changed");
        await syncDirectory(directory);
      }),
    startOfficial: (revision, original) => host.startApprovedRevision(revision, original),
    refreshRegistration: async (_expected, verifiedReceipt) =>
      refreshInstalledRegistration(host.userHome, c, verifiedReceipt),
  });
  const current = await lstat(lock);
  if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino)
    throw Error("Handoff lock ownership changed");
  await rmdir(lock);
  await syncDirectory(directory);
  return receipt;
}
