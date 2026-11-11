import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson } from "./dev-update-store.mjs";

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
async function privateJson(file, optional = false) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Invalid private daemon update record");
    const value = await handle.readFile("utf8");
    const after = await fs.lstat(file);
    if (
      after.isSymbolicLink() ||
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      value.length > 65536
    )
      throw new Error("Private daemon update record changed while reading");
    return JSON.parse(value);
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function privateDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.realpath(directory)) !== path.resolve(directory)
  )
    throw new Error("Unsafe daemon update directory");
}
function validDaemonInstance(instance) {
  return Boolean(
    instance &&
    Number.isSafeInteger(instance.pid) &&
    instance.pid > 0 &&
    Number.isSafeInteger(instance.uid) &&
    typeof instance.startedAt === "string" &&
    instance.startedAt &&
    typeof instance.hostname === "string" &&
    instance.hostname,
  );
}
export function matchesLeaseDaemon(descriptor, instance) {
  return Boolean(
    validDaemonInstance(instance) &&
    descriptor?.version === 1 &&
    descriptor.instance &&
    ["pid", "startedAt", "hostname", "uid"].every(
      (key) => descriptor.instance[key] === instance[key],
    ) &&
    (descriptor.instance.bootId ?? null) === (instance.bootId ?? null) &&
    Number.isSafeInteger(descriptor.workerPid) &&
    descriptor.workerPid > 0 &&
    typeof descriptor.generation === "string" &&
    idPattern.test(descriptor.generation) &&
    descriptor.daemonIdentity ===
      JSON.stringify({
        pid: instance.pid,
        startedAt: instance.startedAt,
        hostname: instance.hostname,
        uid: instance.uid,
        bootId: instance.bootId ?? null,
        workerPid: descriptor.workerPid,
        generation: descriptor.generation,
      }),
  );
}
function validateTicket(value, binding, prior) {
  if (
    !value ||
    value.daemonIdentity !== binding.daemonIdentity ||
    value.candidateDigest !== binding.candidateDigest ||
    value.mode !== binding.mode ||
    typeof value.token !== "string" ||
    !idPattern.test(value.token) ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0 ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    (prior && (value.token !== prior.token || value.epoch !== prior.epoch))
  )
    throw new Error("Invalid or expired daemon update lease");
  return {
    mode: value.mode,
    daemonIdentity: value.daemonIdentity,
    candidateDigest: value.candidateDigest,
    token: value.token,
    expiresAt: value.expiresAt,
    epoch: value.epoch,
  };
}

/** File mailbox is opt-in and local. Absence/unknown identity never falls back to agent-list idle. */
export async function createDaemonUpdateLease({
  control,
  instance,
  candidateDigest,
  mode = "renderer",
  timeoutMs = 10000,
  heartbeatMs = 3000,
  transport,
}) {
  if (mode !== "renderer" || !/^[a-f0-9]{64}$/.test(candidateDigest))
    throw new Error("Unsupported automatic update mode or digest");
  const directory = path.join(control, "daemon-control");
  await privateDirectory(directory);
  const descriptor = await privateJson(path.join(directory, "descriptor.json"), true);
  if (
    !descriptor ||
    !matchesLeaseDaemon(descriptor, instance) ||
    descriptor.capabilities?.rendererLease !== true
  )
    throw new Error("Daemon does not advertise a verified renderer update lease");
  const generationDirectory = path.join(directory, descriptor.generation);
  for (const target of [
    generationDirectory,
    path.join(generationDirectory, "requests"),
    path.join(generationDirectory, "responses"),
  ]) {
    // Check only existing directories; never create a missing daemon generation.
    await fs.access(target);
    await privateDirectory(target);
  }
  const binding = {
    mode,
    daemonIdentity: descriptor.daemonIdentity,
    candidateDigest,
  };
  let ticket,
    lost,
    timer,
    releasePromise,
    closing = false,
    closed = false;
  let serial = Promise.resolve();
  let reportFailure;
  const failure = new Promise((resolve) => {
    reportFailure = resolve;
  });
  async function verifyDescriptor() {
    await privateDirectory(directory);
    for (const target of [
      generationDirectory,
      path.join(generationDirectory, "requests"),
      path.join(generationDirectory, "responses"),
    ])
      await privateDirectory(target);
    const current = await privateJson(path.join(directory, "descriptor.json"));
    if (
      current.daemonIdentity !== descriptor.daemonIdentity ||
      current.generation !== descriptor.generation ||
      !matchesLeaseDaemon(current, instance) ||
      current.capabilities?.rendererLease !== true
    )
      throw new Error("Daemon generation changed during update lease");
  }
  async function exchange(operation) {
    await verifyDescriptor();
    const id = crypto.randomUUID();
    const request = {
      version: 1,
      id,
      operation,
      ...(operation === "prepare" ? { binding } : { ticket }),
    };
    if (transport) {
      let timeout;
      try {
        const result = await Promise.race([
          transport(request),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Daemon update ${operation} timed out`)),
              timeoutMs,
            );
          }),
        ]);
        await verifyDescriptor();
        return result;
      } finally {
        clearTimeout(timeout);
      }
    }
    await atomicJson(path.join(generationDirectory, "requests", `${id}.json`), request);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await privateJson(
        path.join(generationDirectory, "responses", `${id}.json`),
        true,
      );
      if (response) {
        if (response.version !== 1 || response.id !== id || typeof response.ok !== "boolean")
          throw new Error("Invalid daemon update response");
        if (!response.ok) {
          const detail = response.error?.message;
          throw new Error(
            `Daemon update blocked: ${response.error?.code ?? "unknown"}${
              typeof detail === "string" ? `: ${detail.slice(0, 512)}` : ""
            }`,
          );
        }
        await verifyDescriptor();
        return response.result;
      }
      await delay(50);
    }
    throw new Error(`Daemon update ${operation} timed out; no replacement was attempted`);
  }
  function fail(error) {
    lost ??= error;
    clearTimeout(timer);
    reportFailure({ failure: lost.message });
    throw error;
  }
  function run(operation) {
    const next = serial.then(async () => {
      if (closed || (closing && operation !== "abort"))
        throw new Error("Daemon update lease already released");
      if (lost && operation !== "abort") throw lost;
      const value = await exchange(operation);
      if (operation === "abort") {
        if (value?.released !== true) throw new Error("Daemon did not release update lease");
        closed = true;
        return value;
      }
      ticket = validateTicket(value, binding, operation === "prepare" ? null : ticket);
      return ticket;
    });
    serial = next.catch(() => {});
    return next.catch(fail);
  }
  function scheduleHeartbeat() {
    if (closed || closing || lost) return;
    timer = setTimeout(() => {
      void run("renew")
        .then(scheduleHeartbeat)
        .catch(() => {});
    }, heartbeatMs);
    timer.unref?.();
  }
  await run("prepare");
  scheduleHeartbeat();
  return {
    identity: descriptor.daemonIdentity,
    failure,
    check: () => run("inspect"),
    commit: () => run("commit"),
    async release() {
      closing = true;
      clearTimeout(timer);
      if (closed) return;
      releasePromise ??= run("abort");
      await releasePromise;
    },
  };
}

async function exchangeReclamation({ request, generationDirectory, timeoutMs, transport }) {
  let result;
  if (transport) {
    let timer;
    try {
      result = await Promise.race([
        transport(request),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Dependency reclamation outcome unknown; inspect before retrying")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    await atomicJson(path.join(generationDirectory, "requests", `${request.id}.json`), request);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await privateJson(
        path.join(generationDirectory, "responses", `${request.id}.json`),
        true,
      );
      if (response) {
        if (
          response.version !== 1 ||
          response.id !== request.id ||
          typeof response.ok !== "boolean"
        )
          throw new Error("Invalid dependency reclamation response");
        if (!response.ok)
          throw new Error(
            `Dependency reclamation blocked: ${String(response.error?.message ?? "unknown").slice(0, 512)}`,
          );
        result = response.result;
        break;
      }
      await delay(50);
    }
    if (!result) throw new Error("Dependency reclamation outcome unknown; inspect before retrying");
  }
  return result;
}

/** One daemon-owned operation: no caller supplied paths and no blind timeout retry. */
export async function reclaimManagedDependencies({
  control,
  instance,
  registryId,
  evidence,
  timeoutMs = 180000,
  transport,
}) {
  if (
    !/^[a-f0-9]{64}$/.test(registryId) ||
    !/^[a-f0-9]{40}$/.test(evidence?.sourceRevision ?? "") ||
    !/^[a-f0-9]{64}$/.test(evidence?.releaseDigest ?? "")
  )
    throw new Error("Invalid managed dependency reclamation request");
  const directory = path.join(control, "daemon-control");
  await privateDirectory(directory);
  const descriptor = await privateJson(path.join(directory, "descriptor.json"));
  if (
    !matchesLeaseDaemon(descriptor, instance) ||
    descriptor.capabilities?.managedDependencyRetirement !== true
  )
    throw new Error("Daemon does not support verified dependency reclamation");
  const generationDirectory = path.join(directory, descriptor.generation);
  const verify = async () => {
    for (const dir of [
      directory,
      generationDirectory,
      path.join(generationDirectory, "requests"),
      path.join(generationDirectory, "responses"),
    ])
      await privateDirectory(dir);
    const current = await privateJson(path.join(directory, "descriptor.json"));
    if (
      !matchesLeaseDaemon(current, instance) ||
      current.daemonIdentity !== descriptor.daemonIdentity ||
      current.capabilities?.managedDependencyRetirement !== true
    )
      throw new Error(
        "Daemon changed during dependency reclamation; inspect outcome before retrying",
      );
  };
  await verify();
  const id = crypto.randomUUID();
  const request = {
    version: 1,
    id,
    operation: "reclaimDependencies",
    daemonIdentity: descriptor.daemonIdentity,
    registryId,
    evidence,
  };
  const result = await exchangeReclamation({ request, generationDirectory, timeoutMs, transport });
  await verify();
  if (
    result?.detached !== true ||
    typeof result.transactionId !== "string" ||
    !result.transactionId ||
    result.purgePending !== true
  )
    throw new Error("Invalid dependency detach receipt; inspect before retrying");
  return result;
}
