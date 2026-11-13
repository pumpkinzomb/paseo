import {
  constants,
  lstatSync,
  realpathSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
} from "node:fs";
import path from "node:path";

export interface RegisteredDaemon {
  schemaVersion: 1;
  approved: true;
  home: string;
  serverId: string;
  pid: number;
  startedAt: string;
  listen: string;
  version: string;
}
function privateDirectory(root: string, uid: number): void {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || realpathSync(root) !== root)
    throw new Error("Registered daemon directory must be canonical");
  const s = lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o777) !== 0o700)
    throw new Error("Registered daemon directory must be private and owned");
}
function validateRecord(value: RegisteredDaemon, version: string): void {
  if (
    !value ||
    Object.keys(value).sort().join() !==
      "approved,home,listen,pid,schemaVersion,serverId,startedAt,version" ||
    value.schemaVersion !== 1 ||
    value.approved !== true ||
    typeof value.home !== "string" ||
    typeof value.serverId !== "string" ||
    !value.serverId ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startedAt !== "string" ||
    !value.startedAt ||
    value.version !== version ||
    typeof value.listen !== "string"
  )
    throw new Error("Invalid approved daemon registration");
  validateEndpoint(value.listen);
}

function validateEndpoint(listen: string): void {
  const endpoint = new URL(`http://${listen}`);
  if (
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    `${endpoint.host}` !== listen
  )
    throw new Error("Daemon endpoint must be exact loopback host and port");
}

export function readRegisteredDaemon(input: {
  packaged: boolean;
  metadata: unknown;
  userHome: string;
  version: string;
}): RegisteredDaemon | null {
  if (!input.packaged) return null;
  const policy = (
    input.metadata as {
      paseoDistribution?: { schemaVersion?: number; channel?: string; updatePolicy?: string };
    } | null
  )?.paseoDistribution;
  if (
    policy?.schemaVersion !== 1 ||
    policy.channel !== "local" ||
    policy.updatePolicy !== "local-only"
  )
    return null;
  const root = path.join(input.userHome, ".paseo-installed");
  let fd: number;
  try {
    privateDirectory(root, process.getuid!());
    fd = openSync(path.join(root, "daemon.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid!() ||
      (s.mode & 0o777) !== 0o600 ||
      s.nlink !== 1 ||
      s.size > 8192
    )
      throw new Error("Invalid daemon registration file");
    const value = JSON.parse(readFileSync(fd, "utf8")) as RegisteredDaemon;
    validateRecord(value, input.version);
    privateDirectory(value.home, process.getuid!());
    return Object.freeze(value);
  } finally {
    closeSync(fd);
  }
}
export function assertRegisteredDaemonEvidence(
  registration: RegisteredDaemon,
  instance: {
    pid: number;
    startedAt: string;
    uid: number;
    serverId?: string | null;
    listen: string | null;
  } | null,
  status: Record<string, unknown>,
): void {
  if (
    !instance ||
    instance.uid !== process.getuid!() ||
    instance.pid !== registration.pid ||
    instance.startedAt !== registration.startedAt ||
    instance.serverId !== registration.serverId ||
    instance.listen !== registration.listen ||
    status.localDaemon !== "running" ||
    status.pid !== registration.pid ||
    status.startedAt !== registration.startedAt ||
    status.serverId !== registration.serverId ||
    status.listen !== registration.listen ||
    status.daemonVersion !== registration.version
  )
    throw new Error("Registered daemon changed or unavailable; reprovision required");
}
export function assertDaemonLifecycleAllowed(registration: RegisteredDaemon | null): void {
  if (registration) throw new Error("Registered daemon is externally owned and connection-only");
}

/** Renderer may name only the approved endpoint; loopback spelling is not new authority. */
export function isRegisteredCredentialTarget(
  registration: RegisteredDaemon,
  target: unknown,
): boolean {
  if (typeof target !== "string") return false;
  try {
    const raw = target.startsWith("tcp://") ? target.slice(6) : target;
    const selected = new URL(`http://${raw}`);
    const approved = new URL(`http://${registration.listen}`);
    return (
      [approved.hostname, "localhost"].includes(selected.hostname) &&
      selected.port === approved.port &&
      selected.port !== "" &&
      !selected.username &&
      !selected.password &&
      selected.pathname === "/" &&
      !selected.search &&
      !selected.hash &&
      selected.host === raw
    );
  } catch {
    return false;
  }
}
