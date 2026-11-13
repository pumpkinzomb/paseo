import { app, autoUpdater } from "electron";
import { constants } from "node:fs";
import { lstat, open, realpath, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import { z } from "zod";
import { createOfficialDaemonLifecycle } from "./official-daemon-lifecycle.js";
import {
  createHandoffStore,
  validateExactDaemonUpdate,
  type ExactDaemonUpdate,
} from "./installed-daemon-handoff.js";
import {
  prepareInstalledReplacement,
  resumeInstalledReplacement,
} from "./installed-handoff-split.js";
import { requestNativeSquirrelInstall } from "./squirrel-apply.js";
import type { LocalUpdateDriver } from "./ipc.js";

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const installedApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    approved: z.literal(true),
    teamId: z.string().regex(/^[A-Z0-9]{10}$/),
    bundleId: z.literal("sh.paseo.local"),
    candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    zipSha512: z.string().regex(/^[a-f0-9]{128}$/),
    capability: z.custom<ExactDaemonUpdate>(),
  })
  .strict();
const descriptorSchema = z
  .object({
    version: z.literal(1),
    generation: z.string().regex(uuid),
    daemonIdentity: z.string().min(1),
    serverId: z.string(),
    capabilities: z.object({ daemonCommit: z.literal(true) }).passthrough(),
    instance: z
      .object({ uid: z.number().int(), pid: z.number().int().positive(), startedAt: z.string() })
      .passthrough(),
  })
  .passthrough();
const ticketSchema = z
  .object({
    mode: z.literal("daemon"),
    token: z.string().regex(uuid),
    daemonIdentity: z.string(),
    candidateDigest: z.string(),
    epoch: z.number().int(),
    expiresAt: z.number(),
  })
  .strict();
async function directory(p: string) {
  const s = await lstat(p);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid!() ||
    (s.mode & 0o777) !== 0o700 ||
    (await realpath(p)) !== p
  )
    throw Error("Untrusted coordinator directory");
}
async function json(p: string): Promise<unknown | null> {
  let f;
  try {
    f = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const s = await f.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== process.getuid!() ||
      (s.mode & 0o777) !== 0o600 ||
      s.size > 16384
    )
      throw Error("Untrusted coordinator record");
    return JSON.parse(await f.readFile("utf8"));
  } finally {
    await f.close();
  }
}
async function publish(p: string, value: unknown) {
  const existing = await json(p);
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(value))
      throw Error("Conflicting coordinator record");
    return;
  }
  const f = await open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } finally {
    await f.close();
  }
  const d = await open(path.dirname(p), constants.O_RDONLY);
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Main-only factory. No record => null; no caller-provided path/team/process command. */
export async function createInstalledUpdateCoordinator(): Promise<{
  driver: LocalUpdateDriver;
  resumeIfPending(): Promise<void>;
} | null> {
  if (!app.isPackaged) return null;
  const home = os.homedir(),
    root = path.join(home, ".paseo-installed");
  try {
    await directory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const file = path.join(root, "approved-update.json");
  const raw = await json(file);
  if (raw === null) return null;
  const approval = installedApprovalSchema.parse(raw);
  validateExactDaemonUpdate(approval.capability);
  const c = approval.capability;
  if (c.original.uid !== process.getuid!()) throw Error("Update owner mismatch");
  const appPath = app.getAppPath();
  const bundle = path.resolve(appPath, "../../..");
  if (!appPath.endsWith("/Contents/Resources/app.asar") || !bundle.endsWith(".app"))
    throw Error("Unexpected packaged app path");
  const pkg = JSON.parse(await readFile(path.join(appPath, "package.json"), "utf8"));
  const revision = pkg.paseoDistribution?.sourceRevision;
  if (
    ![c.oldRevision, c.nextRevision].includes(revision) ||
    pkg.paseoDistribution?.updatePolicy !== "local-only"
  )
    throw Error("Unapproved running revision");
  async function verifyRunningBundle(expectedRevision: string, version: string) {
    if (revision !== expectedRevision || app.getVersion() !== version)
      throw Error("Running bundle revision/version mismatch");
    const requirement = `=anchor apple generic and identifier "${approval.bundleId}" and certificate leaf[subject.OU] = "${approval.teamId}"`;
    await exec("/usr/bin/codesign", ["--verify", "--strict", "--deep", "-R", requirement, bundle], {
      timeout: 20000,
      maxBuffer: 16384,
    });
  }
  async function verifyApproval() {
    if (JSON.stringify(await json(file)) !== JSON.stringify(raw))
      throw Error("Approved update changed");
    await verifyRunningBundle(
      revision,
      revision === c.nextRevision ? c.nextVersion : c.original.version,
    );
  }
  await verifyApproval();
  const store = await createHandoffStore(home, process.getuid!());
  const transactionDir = path.join(root, "daemon-update-v1");
  const control = path.join(root, "update-control");
  let descriptor: z.infer<typeof descriptorSchema> | undefined;
  let ticket: unknown;
  async function checkDescriptor() {
    await directory(control);
    const value = descriptorSchema.parse(await json(path.join(control, "descriptor.json")));
    if (
      !value ||
      value.version !== 1 ||
      !uuid.test(value.generation) ||
      value.capabilities?.daemonCommit !== true ||
      value.serverId !== c.original.serverId ||
      value.instance?.uid !== c.original.uid ||
      value.instance?.pid !== c.original.pid ||
      value.instance?.startedAt !== c.original.startedAt ||
      typeof value.daemonIdentity !== "string"
    )
      throw Error("Exact daemon update transport unavailable");
    if (descriptor && JSON.stringify(value) !== JSON.stringify(descriptor))
      throw Error("Daemon control generation changed");
    const generation = path.join(control, value.generation);
    for (const d of [
      generation,
      path.join(generation, "requests"),
      path.join(generation, "responses"),
    ])
      await directory(d);
    descriptor = value;
    return generation;
  }
  async function exchange(operation: "prepare" | "commit") {
    const generation = await checkDescriptor();
    const id = randomUUID();
    await publish(path.join(generation, "requests", `${id}.json`), {
      version: 1,
      id,
      operation,
      ...(operation === "prepare"
        ? {
            binding: {
              mode: "daemon",
              daemonIdentity: descriptor!.daemonIdentity,
              candidateDigest: approval.candidateDigest,
            },
          }
        : { ticket }),
    });
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      const response = (await json(path.join(generation, "responses", `${id}.json`))) as Record<
        string,
        unknown
      > | null;
      if (response) {
        if (response.version !== 1 || response.id !== id || response.ok !== true)
          throw Error("Daemon update request refused");
        return response.result;
      }
      await delay(40);
    }
    throw Error("Daemon update request outcome uncertain");
  }
  const lifecycle = createOfficialDaemonLifecycle(c, {
    verifyApprovedCapability: verifyApproval,
    verifyRunningBundle,
    assertCommittedAdmission: async () => {
      throw Error("Coordinator uses transport commit, never secondary stop");
    },
  });
  const host = {
    userHome: home,
    capability: c,
    runningRevision: revision as string,
    verifyApproval,
    readExactInstance: lifecycle.readExactInstance,
    startApprovedRevision: lifecycle.startApprovedRevision,
    verifyAdmission: async () => {
      await publish(path.join(transactionDir, "approval.json"), {
        schemaVersion: 1,
        candidateDigest: approval.candidateDigest,
        capability: c,
      });
      const prepared = ticketSchema.parse(await exchange("prepare"));
      if (
        prepared.daemonIdentity !== descriptor!.daemonIdentity ||
        prepared.candidateDigest !== approval.candidateDigest ||
        prepared.expiresAt <= Date.now()
      )
        throw Error("Update ticket binding mismatch");
      ticket = prepared;
    },
    stopAfterDurablePrepare: async (_expected: unknown, persist: () => Promise<void>) => {
      await persist();
      await exchange("commit");
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const current = await readDaemonInstance(c.original.home);
        if (!current) return;
        if (current.pid !== c.original.pid || current.startedAt !== c.original.startedAt)
          throw Error("Unexpected replacement daemon during shutdown");
        await delay(100);
      }
      throw Error("Official shutdown not completed");
    },
  };
  async function verifyArchive() {
    const archive = path.join(root, "candidates", c.token);
    await directory(path.join(root, "candidates"));
    await directory(archive);
    const f = await open(
      path.join(archive, "candidate.zip"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let bytes: Buffer;
    try {
      const s = await f.stat();
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        s.uid !== process.getuid!() ||
        s.mode & 0o022 ||
        s.size < 1 ||
        s.size > 512 * 1024 * 1024
      )
        throw Error("Unsafe candidate archive");
      bytes = await f.readFile();
    } finally {
      await f.close();
    }
    if (
      createHash("sha512").update(bytes).digest("hex") !== approval.zipSha512 ||
      createHash("sha256").update(bytes).digest("hex") !== approval.candidateDigest
    )
      throw Error("Approved archive changed");
    return archive;
  }
  let phase: "idle" | "applying" | "failed" = "idle";
  const driver: LocalUpdateDriver = {
    readStatus: async () => {
      let archiveReady = false;
      if (revision === c.oldRevision) {
        try {
          await verifyApproval();
          await verifyArchive();
          archiveReady = true;
        } catch {
          /* no unverified offer */
        }
      }
      return {
        currentVersion: app.getVersion(),
        phase,
        ...(archiveReady && revision === c.oldRevision && !(await store.read("hold"))
          ? { candidate: { version: c.nextVersion, token: approval.candidateDigest } }
          : {}),
      };
    },
    requestUpdate: async (token) => {
      if (token !== approval.candidateDigest || revision !== c.oldRevision || phase !== "idle")
        throw Error("Unapproved update request");
      phase = "applying";
      try {
        const archive = await verifyArchive();
        await prepareInstalledReplacement(host);
        await requestNativeSquirrelInstall({
          updater: autoUpdater,
          archive: { directory: archive, sha512: approval.zipSha512 },
          assertDurableHandoffReady: async () => {
            await verifyApproval();
            if (!(await store.read("stopped")) || (await readDaemonInstance(c.original.home)))
              throw Error("Stopped handoff required");
          },
          recordNativeCommit: () =>
            publish(path.join(transactionDir, "native-commit.json"), {
              schemaVersion: 1,
              token: c.token,
              revision: c.nextRevision,
            }),
        });
      } catch (error) {
        phase = "failed";
        throw error;
      }
    },
  };
  return {
    driver,
    async resumeIfPending() {
      const hold = await store.read("hold"),
        stopped = await store.read("stopped");
      if ((hold || revision === c.nextRevision) && !stopped)
        throw Error("Incomplete update handoff requires recovery");
      if (stopped) await resumeInstalledReplacement(host);
    },
  };
}
