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
import { runSupervisor, validateConfig, validateRuntimePaths } from "./dev-update-runtime.mjs";
const exec = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));

async function run(command, args, cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})`));
        return;
      }
      resolve();
    });
  });
}
export async function stageRelease({ source, releases, id, statePreserving }) {
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
  const staging = path.join(path.dirname(source), `paseo-staging-${id}-${crypto.randomUUID()}`);
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
  const stagedPlan = { ...plan, root: staging, protectedRoots: [source, ...plan.protectedRoots] };
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
  const checks = [
    ["npm", ["ci"]],
    ["node", ["scripts/isolated-lab.mjs", "build"]],
    ["npm", ["run", "build:app-deps"]],
    ["npm", ["run", "build:main", "--workspace=@getpaseo/desktop"]],
    ["npm", ["run", "typecheck"]],
    ["npm", ["run", "lint"]],
    ["npm", ["run", "format:check"]],
    ["node", ["--test", "scripts/dev-update.test.mjs"]],
    [
      "npm",
      [
        "exec",
        "--workspace=@getpaseo/desktop",
        "--",
        "vitest",
        "run",
        "src/dev-update",
        "--bail=1",
      ],
    ],
  ];
  for (const [command, args] of checks) await run(command, args, staging, env);
  const stagedStatus = (await exec("git", ["status", "--porcelain"], { cwd: staging })).stdout;
  if (stagedStatus.trim()) throw new Error("Staged source changed during validation");
  // Remove only metadata/state created in this private staging checkout. The
  // original Git repository, running runtime and user state are never touched.
  for (const relative of [".git", ".lab", ".lab-config.json"])
    await fs.rm(path.join(staging, relative), { recursive: true, force: true });
  await detachStagingHardlinks(staging);
  const manifest = {
    schemaVersion: 1,
    id,
    sourceRevision: revision,
    stateCompatibility: "preserve",
    validatedAt: new Date().toISOString(),
    checks: checks.map(([command, args]) => [command, ...args].join(" ")),
    entries: await scanRelease(staging),
  };
  await atomicJson(path.join(staging, "release.json"), manifest);
  await fs.rename(staging, target);
  const digest = manifestDigest(manifest);
  await verifyRelease(releases, id, digest);
  return { id, digest, sourceRevision: revision, root: target };
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
    await verifyRelease(config.releases, required("release"), required("digest"));
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
      previous: null,
      pending: null,
      transition: null,
    });
    console.log("Supervisor initialized, not started. Existing app and launcher unchanged.");
    return;
  }
  const control = path.resolve(required("control"));
  await privateDirectory(control);
  if (action === "queue") {
    const config = await readJson(path.join(control, "config.json"));
    const id = required("release"),
      digest = required("digest");
    await verifyRelease(config.releases, id, digest);
    await queueRelease(control, { id, digest });
    console.log(
      "Update queued. The supervisor automatically relaunches after a safe handoff or a normal quit. Active windows and daemon work are not interrupted.",
    );
  } else if (action === "status") {
    console.log(
      JSON.stringify(
        {
          selection: await readJson(path.join(control, "state.json")),
          status: await readOptionalJson(path.join(control, "status.json")),
          supervisor: await readOptionalJson(path.join(control, "supervisor.lock")),
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
      "Use stage, init, start, queue or status. See docs/runtime-development-separation.md.",
    );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
