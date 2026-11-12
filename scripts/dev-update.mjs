#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolvePlan, assertLocalPaths, labEnv } from "./isolated-lab.mjs";
import {
  assertId,
  atomicJson,
  privateDirectory,
  readJson,
  readOptionalJson,
  scanRelease,
  detachStagingHardlinks,
  manifestDigest,
  verifyRelease,
  queueRelease,
  inside,
} from "./dev-update-store.mjs";
import {
  runSupervisor,
  validateConfig,
  validateRuntimePaths,
  assertRuntimeArtifacts,
  captureBootstrapDaemon,
} from "./dev-update-runtime.mjs";
import { configuredDiscovery, runDiscoveryWatch } from "./dev-update-watch.mjs";
import {
  prepareDependencies,
  verifyDependencyMetadata,
  assertDependencyManifest,
  assertDiskReserve,
} from "./dev-update-dependencies.mjs";
import { registerDependencyScratch, withDependencyScratchLease } from "./dev-update-cleanup.mjs";
import { pruneReleases } from "./dev-update-prune.mjs";
import { reuseTypecheckCaches } from "./typecheck-cache.mjs";
import { reclaimOwnedBuildOutputs } from "./owned-build-outputs.mjs";
function pruneFromOptions(options, required) {
  return pruneReleases({
    control: required("control"),
    releases: required("releases"),
    keep: options.keep === undefined ? 2 : Number(options.keep),
    exclude: options.exclude ? String(options.exclude).split(",") : [],
    apply: options.apply === true,
  });
}
const exec = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));

async function run(command, args, cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const error = new Error(`${command} ${args.join(" ")} failed (${code ?? signal})`);
        error.commandStopped = true;
        reject(error);
        return;
      }
      resolve();
    });
  });
}
export async function prepareStageDependencies(
  {
    staging,
    releases,
    dependencyDonor,
    installDependencies,
    minFreeBytes,
    managedRoot,
    protectedPaths,
  },
  { prepare = prepareDependencies, register = registerDependencyScratch } = {},
) {
  try {
    return await prepare({
      source: staging,
      releases,
      donor: dependencyDonor,
      allowInstall: installDependencies,
      minFreeBytes,
    });
  } catch (error) {
    if (error.dependencyClone) {
      try {
        const record = await register({
          registry: path.join(managedRoot, "cleanup-records"),
          managedRoot,
          scratchRoot: staging,
          ...error.dependencyClone,
          protectedPaths,
          automatic: true,
        });
        const result = await withDependencyScratchLease(record, (lease) => lease.complete());
        error.dependencyCleanup = { ...record, result: result.cleanup };
      } catch (cleanupError) {
        // Retain anything whose stopped ownership or restore copy cannot be proven.
        error.dependencyCleanupError = cleanupError.message;
      }
    }
    throw error;
  }
}

async function runStageChecks({ checks, staging, env, minFreeBytes, stagingIdentity, revision }) {
  try {
    for (const [command, args] of checks) {
      await assertDiskReserve(staging, minFreeBytes);
      await run(command, args, staging, env);
    }
  } catch (error) {
    // A timeout/unknown child lifetime must never become a deletion signal.
    // Preserve source and diagnostics; discard only this invocation's generated outputs.
    if (error.commandStopped) {
      try {
        error.dependencyCleanup = await reclaimOwnedBuildOutputs({
          root: staging,
          identity: stagingIdentity,
          sourceRevision: revision,
        });
      } catch (cleanupError) {
        error.dependencyCleanupError = cleanupError.message;
      }
    }
    await atomicJson(path.join(staging, "failed-stage.json"), {
      state: error.commandStopped ? "failed-stopped" : "failed-unknown",
      error: error.message,
      cleanup: error.dependencyCleanup ?? null,
      cleanupError: error.dependencyCleanupError ?? null,
    });
    throw error;
  }
}

export async function stageRelease({
  source,
  releases,
  id,
  statePreserving,
  dependencyDonor,
  installDependencies = false,
  minFreeBytes = 8 * 1024 ** 3,
}) {
  if (!statePreserving)
    throw new Error(
      "Review state/schema compatibility and explicitly pass --state-preserving; migrations are unsupported",
    );
  assertId(id);
  source = await fs.realpath(source);
  const plan = resolvePlan(source, await readJson(path.join(source, ".lab-config.json")));
  assertLocalPaths(plan);
  releases = path.resolve(releases);
  if (source === releases || inside(source, releases) || inside(releases, source))
    throw new Error("Staging directory overlaps source");
  const git = async (...args) =>
    (await exec("git", args, { cwd: source, maxBuffer: 20 * 1024 * 1024 })).stdout;
  if ((await git("status", "--porcelain")).trim())
    throw new Error("Commit source changes before staging; source must be clean");
  const revision = (await git("rev-parse", "HEAD")).trim();
  await fs.mkdir(releases, { recursive: true });
  releases = await fs.realpath(releases);
  const target = path.join(releases, id);
  if (
    await fs.lstat(target).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new Error("Release ID already exists; never overwrite a release");
  // Build beside the lab, not under protected runtime roots. The validated
  // tree is promoted by rename only after all work has finished.
  const managedRoot = path.join(path.dirname(source), ".paseo-build-scratch");
  await privateDirectory(managedRoot);
  const staging = path.join(managedRoot, `stage-${id}-${crypto.randomUUID()}`);
  await privateDirectory(staging);
  const stagingIdentity = await fs.lstat(staging);
  // Freeze the commit BEFORE testing. A source edit during a long build cannot
  // get copied into a release after its checks passed. No working-tree files,
  // session stores, ignored .env/auth, or live dependencies are copied.
  await run(
    "git",
    ["clone", "--no-hardlinks", "--no-checkout", source, staging],
    source,
    process.env,
  );
  await run("git", ["checkout", "--detach", revision], staging, process.env);
  const stagedPlan = {
    ...plan,
    root: staging,
    protectedRoots: [source, ...plan.protectedRoots],
  };
  await atomicJson(path.join(staging, ".lab-config.json"), {
    role: "development-lab",
    root: staging,
    protectedRoots: stagedPlan.protectedRoots,
    daemonPort: plan.daemonPort,
    metroPort: plan.metroPort,
  });
  const env = labEnv(
    resolvePlan(staging, await readJson(path.join(staging, ".lab-config.json"))),
    process.env,
  );
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  const dependencies = await prepareStageDependencies({
    staging,
    releases,
    dependencyDonor,
    installDependencies,
    minFreeBytes,
    managedRoot,
    protectedPaths: [source, ...plan.protectedRoots],
  });
  const typecheckCache = await reuseTypecheckCaches({
    source,
    staging,
    revision,
  });
  console.log("Typecheck cache reuse:", JSON.stringify(typecheckCache));
  const checks = [
    ...(dependencies.mode === "install" ? [["npm", ["ci"]]] : []),
    [
      "node",
      [
        "-e",
        "const fs=require('node:fs'); const executable=require('electron'); fs.accessSync(executable,fs.constants.X_OK); console.log('Electron binary installed:',executable);",
      ],
    ],
    ["node", ["scripts/isolated-lab.mjs", "build"]],
    ["npm", ["run", "build:app-deps"]],
    ["npm", ["run", "build:main", "--workspace=@getpaseo/desktop"]],
    ["npm", ["run", "typecheck"]],
    ["npm", ["run", "lint"]],
    ["npm", ["run", "format:check"]],
    ["node", ["--test", "scripts/daemon-launch-contract.test.mjs"]],
    [
      "npm",
      [
        "exec",
        "--workspace=@getpaseo/desktop",
        "--",
        "vitest",
        "run",
        "src/dev-update",
        "src/daemon/daemon-manager.test.ts",
        "--bail=1",
      ],
    ],
  ];
  await runStageChecks({
    checks,
    staging,
    env,
    minFreeBytes,
    stagingIdentity,
    revision,
  });
  if (dependencies.mode === "reuse") {
    await verifyDependencyMetadata(staging, dependencies.entries);
    await verifyRelease(releases, dependencyDonor.id, dependencyDonor.digest);
  }
  const stagedStatus = (await exec("git", ["status", "--porcelain"], { cwd: staging })).stdout;
  if (stagedStatus.trim()) throw new Error("Staged source changed during validation");
  // Remove only metadata/state created in this private staging checkout. The
  // original Git repository, running runtime and user state are never touched.
  for (const relative of [".git", ".lab", ".lab-config.json"])
    await fs.rm(path.join(staging, relative), { recursive: true, force: true });
  await assertRuntimeArtifacts(staging);
  await detachStagingHardlinks(staging);
  const entries = await scanRelease(staging);
  if (dependencies.mode === "reuse") assertDependencyManifest(dependencies.entries, entries);
  const manifest = {
    schemaVersion: 1,
    id,
    sourceRevision: revision,
    stateCompatibility: "preserve",
    validatedAt: new Date().toISOString(),
    checks: checks.map(([command, args]) => [command, ...args].join(" ")),
    typecheckCache,
    dependencies: {
      mode: dependencies.mode,
      ...(dependencies.donor ? { donor: dependencies.donor } : {}),
    },
    entries,
  };
  await atomicJson(path.join(staging, "release.json"), manifest);
  await fs.rename(staging, target);
  const digest = manifestDigest(manifest);
  await verifyRelease(releases, id, digest);
  return { id, digest, sourceRevision: revision, root: target };
}

async function discoveryCommand(action, control) {
  if (action === "check-updates") {
    const watcher = await configuredDiscovery(control);
    if (!watcher) throw new Error("Update discovery is not enabled");
    try {
      console.log(JSON.stringify(await watcher.pollOnce(), null, 2));
    } finally {
      await watcher.stop();
    }
  } else if (action === "watch-updates") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    // Discovery timers are unref'ed for embedded use; this process owns a persistent watch.
    const keepAlive = setInterval(() => {}, 60_000);
    try {
      await runDiscoveryWatch(control, { signal: controller.signal });
    } finally {
      clearInterval(keepAlive);
    }
  } else if (action === "start-update-watch") {
    const configured = await configuredDiscovery(control);
    if (!configured) throw new Error("Update discovery is not enabled");
    await configured.stop();
    if (await readOptionalJson(path.join(control, "discovery-watcher.lock")))
      throw new Error("Discovery watcher lock exists; reconcile it before starting another");
    const log = await fs.open(path.join(control, "discovery-watcher.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [path.join(directory, "dev-update.mjs"), "watch-updates", "--control", control],
      { detached: true, stdio: ["ignore", log.fd, log.fd] },
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    await log.close();
    console.log(
      `Discovery watcher launched (PID ${child.pid}); verify status for the first check result.`,
    );
  } else return false;
  return true;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) throw new Error(`Unexpected argument ${args[i]}`);
    const key = args[i].slice(2);
    options[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  }
  const required = (key) => {
    if (typeof options[key] !== "string") throw new Error(`Missing --${key}`);
    return options[key];
  };
  if (action === "stage") {
    console.log(
      JSON.stringify(
        await stageRelease({
          source: required("source"),
          releases: required("releases"),
          id: required("id"),
          statePreserving: options["state-preserving"] === true,
          dependencyDonor:
            options["dependency-release"] || options["dependency-digest"]
              ? {
                  id: required("dependency-release"),
                  digest: required("dependency-digest"),
                }
              : undefined,
          installDependencies: options["install-dependencies"] === true,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (action === "init") {
    const control = path.resolve(required("control"));
    const config = await readJson(required("config"));
    validateConfig(config);
    await validateRuntimePaths(config, control);
    const selected = await verifyRelease(config.releases, required("release"), required("digest"));
    const bootstrap =
      options["retain-current-daemon"] === true
        ? await captureBootstrapDaemon(config, {
            ...selected,
            digest: options.digest,
          })
        : null;
    await privateDirectory(control);
    if (await readOptionalJson(path.join(control, "state.json")))
      throw new Error("Already initialized; no existing selection overwritten");
    // Exclusive creation fences concurrent initialization. Publish state last,
    // after the installed controller is complete; partial init is not usable.
    await fs.mkdir(path.join(control, "controller"), { mode: 0o700 });
    await atomicJson(path.join(control, "config.json"), config);
    for (const file of [
      "dev-update.mjs",
      "dev-update-store.mjs",
      "dev-update-runtime.mjs",
      "dev-update-automatic.mjs",
      "dev-update-lease.mjs",
      "dev-update-watch.mjs",
      "dev-update-discovery.mjs",
      "dev-update-full-stage.mjs",
      "dev-update-dependencies.mjs",
      "dev-update-cleanup.mjs",
      "owned-build-outputs.mjs",
      "stopped-build-dependencies.mjs",
      "cleanup-legacy-lab.mjs",
      "dev-update-prune.mjs",
      "managed-worktree-maintenance.mjs",
      "managed-worktree-retirement.mjs",
      "dev-update-validation.mjs",
      "typecheck-cache.mjs",
      "isolated-lab.mjs",
    ])
      await fs.copyFile(
        path.join(directory, file),
        path.join(control, "controller", file),
        constants.COPYFILE_EXCL,
      );
    await atomicJson(path.join(control, "state.json"), {
      schemaVersion: 1,
      current: { id: options.release, digest: options.digest },
      ...(bootstrap ? { bootstrap } : {}),
      previous: null,
      pending: null,
      transition: null,
    });
    console.log("Supervisor initialized, not started. Existing app and launcher unchanged.");
    return;
  }
  const control = path.resolve(required("control"));
  await privateDirectory(control);
  if (await discoveryCommand(action, control)) return;
  if (action === "queue") {
    const config = await readJson(path.join(control, "config.json"));
    const id = required("release"),
      digest = required("digest");
    await verifyRelease(config.releases, id, digest);
    await queueRelease(control, { id, digest });
    console.log(
      "Update queued. The supervisor automatically relaunches after a safe handoff or a normal quit. Work is not force-stopped; unsafe updates remain pending.",
    );
  } else if (action === "status") {
    console.log(
      JSON.stringify(
        {
          selection: await readJson(path.join(control, "state.json")),
          status: await readOptionalJson(path.join(control, "status.json")),
          supervisor: await readOptionalJson(path.join(control, "supervisor.lock")),
          discovery: await readOptionalJson(path.join(control, "discovery.json")),
          discoveryWatcher: await readOptionalJson(path.join(control, "discovery-watcher.lock")),
          automaticSuppression: await readOptionalJson(
            path.join(control, "automatic-suppression.json"),
          ),
          note: "Recorded state only. A lock is not proof that a supervisor is still alive.",
        },
        null,
        2,
      ),
    );
  } else if (action === "supervise") await runSupervisor(control);
  else if (action === "start") {
    if (await readOptionalJson(path.join(control, "supervisor.lock")))
      throw new Error("Supervisor lock already exists; not starting another instance");
    const log = await fs.open(path.join(control, "supervisor.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [path.join(control, "controller/dev-update.mjs"), "supervise", "--control", control],
      { detached: true, stdio: ["ignore", log.fd, log.fd] },
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    await log.close();
    console.log(
      `Supervisor launched (PID ${child.pid}). Use status to verify startup; this is not a readiness confirmation.`,
    );
  } else
    throw new Error(
      "Use stage, init, start, queue, check-updates, start-update-watch, prune-releases or status. See docs/runtime-development-separation.md.",
    );
}
async function runCommand() {
  if (process.argv[2] !== "prune-releases") return main();
  const options = {};
  const args = process.argv.slice(3);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, "");
    if (!["control", "releases", "keep", "exclude", "apply"].includes(key))
      throw new Error(`Unknown option: ${args[i]}`);
    const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
    if (key !== "apply" && typeof value !== "string") throw new Error(`Missing --${key} value`);
    if (key === "apply" && value !== true) throw new Error("--apply takes no value");
    if (key === "exclude" && options.exclude) options.exclude += `,${value}`;
    else options[key] = value;
  }
  const required = (key) => {
    if (typeof options[key] !== "string") throw new Error(`Missing --${key}`);
    return options[key];
  };
  const result = await pruneFromOptions(options, required);
  console.log(JSON.stringify(result, null, 2));
  if (["blocked", "failed"].includes(result.state)) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runCommand().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
