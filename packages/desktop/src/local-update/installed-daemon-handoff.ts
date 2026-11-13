import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface HandoffIdentity {
  uid: number;
  home: string;
  serverId: string;
  pid: number;
  startedAt: string;
  listen: string;
  version: string;
}
export interface ExactDaemonUpdate {
  schemaVersion: 1;
  token: string;
  oldRevision: string;
  nextRevision: string;
  nextVersion: string;
  original: HandoffIdentity;
}
export interface HandoffReceipt {
  schemaVersion: 1;
  token: string;
  revision: string;
  instance: HandoffIdentity;
}
export interface HandoffPort {
  /** Host-owned exclusive update/admission fence, not renderer supplied. */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  verifyApproval(capability: ExactDaemonUpdate): Promise<void>;
  /** Must deny new jobs and prove active jobs/writers settled, not merely idle UI. */
  verifyAdmission(capability: ExactDaemonUpdate): Promise<void>;
  readRegistration(): Promise<HandoffIdentity>;
  readInstance(): Promise<HandoffIdentity | null>;
  stopOfficial(expected: HandoffIdentity): Promise<void>;
  startOfficial(revision: string, original: HandoffIdentity): Promise<HandoffIdentity>;
  /** Atomic exact-old registration compare-and-swap; must never overwrite a conflict. */
  refreshRegistration(expected: HandoffIdentity, receipt: HandoffReceipt): Promise<void>;
}
function same(a: HandoffIdentity, b: HandoffIdentity): boolean {
  return ["uid", "home", "serverId", "pid", "startedAt", "listen", "version"].every(
    (k) => a[k as keyof HandoffIdentity] === b[k as keyof HandoffIdentity],
  );
}
function identity(value: HandoffIdentity): void {
  if (
    !value ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    !path.isAbsolute(value.home) ||
    path.resolve(value.home) !== value.home ||
    !value.serverId ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !value.startedAt ||
    !value.version
  )
    throw Error("Invalid handoff identity");
  const url = new URL(`http://${value.listen}`);
  if (
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.host !== value.listen ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("Invalid handoff endpoint");
}
export function validateExactDaemonUpdate(c: ExactDaemonUpdate): void {
  if (
    !c ||
    c.schemaVersion !== 1 ||
    !/^[a-f0-9]{32}$/.test(c.token) ||
    !/^[a-f0-9]{40}$/.test(c.oldRevision) ||
    !/^[a-f0-9]{40}$/.test(c.nextRevision) ||
    c.oldRevision === c.nextRevision ||
    !c.nextVersion
  )
    throw Error("Invalid exact update capability");
  identity(c.original);
}
async function privateDir(directory: string, uid: number): Promise<void> {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory
  )
    throw Error("Untrusted handoff directory");
}
/** Fixed store under trusted OS user home. No caller-selected script or record paths. */
export async function createHandoffStore(userHome: string, uid: number) {
  const root = path.join(userHome, ".paseo-installed");
  await privateDir(root, uid);
  const directory = path.join(root, "daemon-update-v1");
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await privateDir(directory, uid);
  const rootHandle = await open(root, constants.O_RDONLY);
  try {
    await rootHandle.sync();
  } finally {
    await rootHandle.close();
  }
  async function read(name: "hold" | "receipt" | "stopped"): Promise<unknown | null> {
    let file;
    try {
      file = await open(
        path.join(directory, `${name}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== uid ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 8192
      )
        throw Error("Untrusted handoff record");
      return JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  }
  async function write(name: "hold" | "receipt" | "stopped", value: unknown) {
    const file = await open(
      path.join(directory, `${name}.json`),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    const dir = await open(directory, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    // Crash during a partial record deliberately fails closed on subsequent reads.
  }
  return { read, write };
}
export type HandoffStore = Awaited<ReturnType<typeof createHandoffStore>>;

/** Inactive unless trusted main wires approval, admission, official lifecycle and CAS. */
export async function runExactDaemonHandoff(
  capability: ExactDaemonUpdate,
  revision: string,
  store: HandoffStore,
  port: HandoffPort,
) {
  validateExactDaemonUpdate(capability);
  if (revision !== capability.nextRevision && revision !== capability.oldRevision)
    throw Error("Unapproved startup revision");
  return port.exclusive(async () => {
    await port.verifyApproval(capability);
    const hold = await store.read("hold");
    if (hold !== null && JSON.stringify(hold) !== JSON.stringify(capability))
      throw Error("Conflicting handoff hold");
    const saved = (await store.read("receipt")) as HandoffReceipt | null;
    if (saved) {
      if (hold === null) throw Error("Receipt without hold");
      return resumeReceipt(capability, revision, saved, port);
    }
    if (!same(await port.readRegistration(), capability.original))
      throw Error("Registration changed");
    await port.verifyAdmission(capability);
    const live = await port.readInstance();
    if (live && !same(live, capability.original)) throw Error("Unexpected daemon instance");
    if (hold === null) {
      if (!live) throw Error("Original daemon missing before hold");
      await store.write("hold", capability); // fsync before any official stop
    }
    if (live) {
      if (!same(await port.readRegistration(), capability.original))
        throw Error("Registration changed before stop");
      const recheck = await port.readInstance();
      if (!recheck || !same(recheck, capability.original))
        throw Error("Instance changed before stop");
      await port.stopOfficial(capability.original);
    }
    if (await port.readInstance()) throw Error("Daemon still running after stop");
    if (!same(await port.readRegistration(), capability.original))
      throw Error("Registration changed before start");
    const started = await port.startOfficial(revision, capability.original);
    validateResult(capability, revision, started);
    const observed = await port.readInstance();
    if (!observed || !same(observed, started)) throw Error("Official start not verified");
    const receipt: HandoffReceipt = {
      schemaVersion: 1,
      token: capability.token,
      revision,
      instance: started,
    };
    await store.write("receipt", receipt);
    await port.refreshRegistration(capability.original, receipt);
    return receipt;
  });
}
function validateResult(c: ExactDaemonUpdate, revision: string, result: HandoffIdentity) {
  identity(result);
  if (
    result.uid !== c.original.uid ||
    result.home !== c.original.home ||
    result.serverId !== c.original.serverId ||
    result.listen !== c.original.listen ||
    result.version !== (revision === c.nextRevision ? c.nextVersion : c.original.version) ||
    (result.pid === c.original.pid && result.startedAt === c.original.startedAt)
  )
    throw Error("Started daemon escaped exact handoff");
}

async function resumeReceipt(
  capability: ExactDaemonUpdate,
  revision: string,
  saved: HandoffReceipt,
  port: HandoffPort,
): Promise<HandoffReceipt> {
  if (saved.schemaVersion !== 1 || saved.token !== capability.token || saved.revision !== revision)
    throw Error("Conflicting handoff receipt");
  validateResult(capability, revision, saved.instance);
  const live = await port.readInstance();
  if (!live || !same(live, saved.instance)) throw Error("Receipt instance no longer matches");
  const registration = await port.readRegistration();
  if (same(registration, saved.instance)) return saved;
  if (!same(registration, capability.original)) throw Error("Registration changed");
  await port.refreshRegistration(capability.original, saved);
  return saved;
}
