import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { inspectCandidate, INTENT_FILE } from "./dev-update-discovery.mjs";
import { validationEnvironment, validateCandidateLaunch } from "./dev-update-validation.mjs";
import {
  acquireLock,
  atomicJson,
  inside,
  manifestDigest,
  privateDirectory,
  readOptionalJson,
  verifyRelease,
} from "./dev-update-store.mjs";

const exec = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const result = server.address().port;
      server.close(() => resolve(result));
    });
  });
}
async function git(cwd, args, env) {
  return (
    await exec("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
      env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 ** 2,
    })
  ).stdout.trim();
}
async function stageInWorker({
  source,
  releases,
  id,
  statePreserving,
  fixture,
  dependencyDonor,
  minFreeBytes,
}) {
  const args = {
    source,
    releases,
    id,
    statePreserving,
    dependencyDonor,
    minFreeBytes,
    installDependencies: true,
  };
  const input = path.join(fixture, "stage-input.json"),
    output = path.join(fixture, "stage-output.json");
  await atomicJson(input, args);
  const log = await fs.open(path.join(fixture, "build.log"), "wx", 0o600);
  const buildEnv = validationEnvironment(fixture);
  delete buildEnv.npm_config_offline;
  const child = spawn(process.execPath, [modulePath, "--worker", input, output], {
    env: buildEnv,
    cwd: fixture,
    stdio: ["ignore", log.fd, log.fd],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await log.close();
  await atomicJson(path.join(fixture, "build-worker.json"), {
    pid: child.pid,
    source,
  });
  let timer;
  try {
    const exit = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.unref();
          const error = new Error(`Full build timed out; worker/artifacts retained: ${fixture}`);
          error.retainedWorker = true;
          reject(error);
        }, 60 * 60_000);
      }),
    ]);
    const result = await readOptionalJson(output);
    if (exit.code !== 0 || !result?.ok)
      throw new Error(result?.error || "Full stage worker failed");
    return result.selection;
  } finally {
    clearTimeout(timer);
  }
}
async function prepareDirectories({ cacheRoot, releases, protectedPaths }) {
  if (!path.isAbsolute(cacheRoot) || path.resolve(cacheRoot) !== cacheRoot)
    throw new Error("Full stage cache must be absolute and canonical");
  if (!Array.isArray(protectedPaths) || !protectedPaths.length)
    throw new Error("Full stage requires all protected source/home/profile paths");
  const protectedRoots = [
    ...new Set([
      await fs.realpath(releases),
      ...(await Promise.all(protectedPaths.map((value) => fs.realpath(value)))),
    ]),
  ];
  for (const root of protectedRoots)
    if (root === cacheRoot || inside(root, cacheRoot) || inside(cacheRoot, root))
      throw new Error("Full stage cache overlaps protected state");
  await privateDirectory(cacheRoot);
  return protectedRoots;
}
async function reserveDisk(cacheRoot, manifest, root, minFreeBytes, availableBytes) {
  if (!Number.isFinite(minFreeBytes) || minFreeBytes < 0)
    throw new Error("Invalid full build disk reserve");
  const stats = await fs.statfs(cacheRoot);
  let size = 0;
  for (const relative of Object.keys(manifest.entries)) {
    const info = await fs.lstat(path.join(root, relative));
    if (info.isFile()) size += info.size;
  }
  if ((availableBytes ?? stats.bavail * stats.bsize) < size + minFreeBytes)
    throw new Error("Insufficient full build disk reserve");
}

// A successful stage no longer needs its private source, npm cache or test home.
// Failed/timed-out stages are intentionally retained for diagnosis; this is not
// a sweep of arbitrary lab directories or other agents' working trees.
async function cleanupSuccessfulFixture({ cacheRoot, fixture, identity, receipt }) {
  const current = await fs.lstat(fixture);
  if (
    (await fs.realpath(cacheRoot)) !== cacheRoot ||
    path.dirname(fixture) !== cacheRoot ||
    (await fs.realpath(fixture)) !== fixture ||
    !current.isDirectory() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    throw new Error("Full stage fixture identity changed; retained for review");
  const source = path.join(fixture, "source");
  if (
    await git(
      source,
      ["status", "--porcelain", "--untracked-files=all"],
      validationEnvironment(fixture),
    )
  )
    throw new Error("Full stage source changed; retained for review");
  let buildLogTail = "";
  try {
    const file = await fs.open(path.join(fixture, "build.log"), "r");
    try {
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        Math.max(0, size - buffer.length),
      );
      buildLogTail = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Keep one bounded diagnostic summary, not another complete build tree.
  await atomicJson(path.join(cacheRoot, "last-full-stage.json"), {
    ...receipt,
    completedAt: new Date().toISOString(),
    buildLogTail,
  });
  await fs.rm(fixture, { recursive: true });
}

async function isolatedPorts() {
  let daemonPort = await port(),
    metroPort = await port();
  while (metroPort === daemonPort || [6767, 6768, 8081, 8082, 8084].includes(metroPort))
    metroPort = await port();
  while ([6767, 6768, 8081, 8082, 8084].includes(daemonPort) || daemonPort === metroPort)
    daemonPort = await port();
  return { daemonPort, metroPort };
}

/** Stages only. Full daemon replacement still requires its independent runtime gate. */
export async function stageFullRelease({
  repository,
  candidate,
  current,
  releases,
  cacheRoot,
  protectedPaths,
  minFreeBytes = 8 * 1024 ** 3,
  availableBytes,
  stage = stageInWorker,
  validateLaunch,
}) {
  const protectedRoots = await prepareDirectories({
    cacheRoot,
    releases,
    protectedPaths,
  });
  const unlock = await acquireLock(cacheRoot, "full-stage.lock");
  let retainLock = false;
  try {
    const base = await verifyRelease(releases, current.id, current.digest);
    const checked = await inspectCandidate({
      repository,
      installedRevision: base.manifest.sourceRevision,
      candidateRevision: candidate.revision,
    });
    if (
      checked.state !== "eligible" ||
      checked.intent.mode !== "full" ||
      checked.intent.stateCompatibility !== "preserve"
    )
      throw new Error("Full staging requires exact verified full preserve declaration");
    await reserveDisk(cacheRoot, base.manifest, base.root, minFreeBytes, availableBytes);
    const id = `full-${checked.revision.slice(0, 16)}-${current.digest.slice(0, 12)}`;
    const fixture = path.join(cacheRoot, `full-build-${id}-${crypto.randomUUID()}`);
    await privateDirectory(fixture);
    const fixtureIdentity = await fs.lstat(fixture);
    for (const name of ["os-home", "tmp"]) await privateDirectory(path.join(fixture, name));
    const env = validationEnvironment(fixture);
    env.GIT_TERMINAL_PROMPT = "0";
    const source = path.join(fixture, "source");
    await git(
      fixture,
      ["clone", "--no-hardlinks", "--no-checkout", await fs.realpath(repository), source],
      env,
    );
    await git(source, ["checkout", "--detach", checked.revision], env);
    // Private Git metadata only; no source file is altered to hide dirty content.
    await fs.appendFile(path.join(source, ".git", "info", "exclude"), "\n/.lab-config.json\n");
    const { daemonPort, metroPort } = await isolatedPorts();
    await atomicJson(path.join(source, ".lab-config.json"), {
      role: "development-lab",
      root: source,
      protectedRoots,
      daemonPort,
      metroPort,
    });
    if (await git(source, ["status", "--porcelain", "--untracked-files=all"], env))
      throw new Error("Private source checkout is not clean");
    const rechecked = await inspectCandidate({
      repository: source,
      installedRevision: base.manifest.sourceRevision,
      candidateRevision: checked.revision,
    });
    if (rechecked.state !== "eligible" || rechecked.intent.mode !== "full")
      throw new Error("Detached source intent changed before full stage");
    await verifyRelease(releases, current.id, current.digest);
    const existing = await readOptionalJson(path.join(releases, id, "release.json"));
    const selected = existing
      ? { id, digest: manifestDigest(existing) }
      : await stage({
          source,
          releases,
          id,
          statePreserving: rechecked.intent.stateCompatibility === "preserve",
          fixture,
          dependencyDonor: { id: current.id, digest: current.digest },
          minFreeBytes,
        });
    const sealed = await verifyRelease(releases, selected.id, selected.digest);
    if (selected.id !== id || sealed.manifest.sourceRevision !== checked.revision)
      throw new Error("Full stage returned the wrong release revision");
    const sealedIntent = JSON.parse(await fs.readFile(path.join(sealed.root, INTENT_FILE), "utf8"));
    if (JSON.stringify(sealedIntent) !== JSON.stringify(rechecked.intent))
      throw new Error("Sealed full release does not contain its verified declaration");
    const receipt = {
      schemaVersion: 1,
      selection: { id: selected.id, digest: selected.digest },
      baseDigest: current.digest,
      sourceRevision: checked.revision,
      intent: rechecked.intent,
      validated: false,
    };
    await atomicJson(path.join(fixture, "provenance.json"), receipt);
    const validate =
      validateLaunch ??
      ((input) =>
        validateCandidateLaunch({
          ...input,
          workRoot: path.join(cacheRoot, "validation"),
        }));
    await validate({ root: sealed.root, candidate: checked, current });
    await verifyRelease(releases, selected.id, selected.digest);
    await verifyRelease(releases, current.id, current.digest);
    const completedReceipt = { ...receipt, validated: true };
    await cleanupSuccessfulFixture({
      cacheRoot,
      fixture,
      identity: fixtureIdentity,
      receipt: completedReceipt,
    });
    return { id: selected.id, digest: selected.digest };
  } catch (error) {
    retainLock = error.retainedWorker === true;
    throw error;
  } finally {
    if (!retainLock) await unlock();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === modulePath &&
  process.argv[2] === "--worker"
) {
  const input = process.argv[3],
    output = process.argv[4];
  try {
    const { stageRelease } = await import("./dev-update.mjs");
    const selection = await stageRelease(JSON.parse(await fs.readFile(input, "utf8")));
    await atomicJson(output, { ok: true, selection });
  } catch (error) {
    await atomicJson(output, { ok: false, error: error.message });
    process.exitCode = 1;
  }
}
