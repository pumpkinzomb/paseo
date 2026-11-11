import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  acquireLock,
  atomicJson,
  hash,
  inside,
  isRendererOnly,
  manifestDigest,
  privateDirectory,
  changeState,
  readOptionalJson,
  scanRelease,
  verifyRelease,
} from "./dev-update-store.mjs";

const exec = promisify(execFile);
export const INTENT_FILE = "dev-update-release.json";
const revisionPattern = /^[a-f0-9]{40}$/;
const rendererPath = /^packages\/app\/(src|assets)\//;
const metadataPath = /^(docs\/|dev-update-release\.json$)/;

async function git(repository, args, binary = false) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_TERMINAL_PROMPT = "0";
  const { stdout } = await exec(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-C", repository, ...args],
    {
      env,
      encoding: binary ? "buffer" : "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  return stdout;
}
function revision(value) {
  if (!revisionPattern.test(value)) throw new Error("Expected an exact Git SHA-1 revision");
  return value;
}
async function ancestor(repository, older, newer) {
  try {
    await git(repository, ["merge-base", "--is-ancestor", older, newer]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}
async function tree(repository, commit) {
  const output = await git(repository, ["ls-tree", "-rz", "--full-tree", revision(commit)]);
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      return { mode, type, oid, name: record.slice(tab + 1), record };
    });
}
export async function candidateContentDigest(repository, commit) {
  const entries = await tree(repository, commit);
  return hash(
    entries
      .filter((entry) => entry.name !== INTENT_FILE)
      .map((entry) => `${entry.record}\0`)
      .join(""),
  );
}

// Commit source first, then commit the returned declaration. The declaration is
// excluded from the digest, so its own commit does not create a hash cycle.
export async function prepareReleaseIntent({ repository, baseRevision, mode }) {
  if (!["renderer", "full"].includes(mode)) throw new Error("Invalid release mode");
  const head = (await git(repository, ["rev-parse", "HEAD"])).trim();
  revision(baseRevision);
  if (!(await ancestor(repository, baseRevision, head)))
    throw new Error("Base is not an ancestor of source HEAD");
  const dirty = await git(repository, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty.trim()) throw new Error("Prepare intent only in a clean independent checkout");
  return {
    schemaVersion: 1,
    baseRevision,
    contentDigest: await candidateContentDigest(repository, head),
    stateCompatibility: "preserve",
    mode,
  };
}

export async function inspectCandidate({ repository, installedRevision, candidateRevision }) {
  revision(installedRevision);
  revision(candidateRevision);
  if (installedRevision === candidateRevision) return { state: "current" };
  if (await ancestor(repository, candidateRevision, installedRevision)) return { state: "behind" };
  if (!(await ancestor(repository, installedRevision, candidateRevision)))
    return { state: "rejected", reason: "diverged" };
  let intent;
  try {
    intent = JSON.parse(await git(repository, ["show", `${candidateRevision}:${INTENT_FILE}`]));
  } catch {
    return { state: "rejected", reason: "missing-or-invalid-intent" };
  }
  const digest = await candidateContentDigest(repository, candidateRevision);
  if (
    intent?.schemaVersion !== 1 ||
    intent.baseRevision !== installedRevision ||
    intent.contentDigest !== digest ||
    intent.stateCompatibility !== "preserve" ||
    !["renderer", "full"].includes(intent.mode)
  ) {
    return { state: "rejected", reason: "intent-does-not-bind-this-update" };
  }
  const changedPaths = (
    await git(repository, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      installedRevision,
      candidateRevision,
    ])
  )
    .split("\0")
    .filter(Boolean);
  const entries = await tree(repository, candidateRevision);
  if (
    intent.mode === "renderer" &&
    (changedPaths.some((name) => !rendererPath.test(name) && !metadataPath.test(name)) ||
      entries.some(
        (entry) =>
          changedPaths.includes(entry.name) &&
          rendererPath.test(entry.name) &&
          !["100644", "100755"].includes(entry.mode),
      ))
  ) {
    return { state: "rejected", reason: "renderer-declaration-changes-native-or-dependencies" };
  }
  return {
    state: "eligible",
    revision: candidateRevision,
    intent,
    contentDigest: digest,
    changedPaths,
  };
}

function validateChannel(config) {
  const url = new URL(config.remoteUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname) ||
    config.ref !== "refs/heads/main"
  )
    throw new Error("Discovery requires a pinned GitHub HTTPS fork and refs/heads/main");
}

export async function validateDiscoveryConfig(config) {
  validateChannel(config);
  if (!path.isAbsolute(config.cacheRoot) || path.resolve(config.cacheRoot) !== config.cacheRoot)
    throw new Error("Cache root must be absolute and canonical");
  if (!Array.isArray(config.protectedPaths) || config.protectedPaths.length === 0)
    throw new Error("Protected source, release, control, home and profile paths are required");
  for (const protectedPath of config.protectedPaths) {
    const canonical = await fs.realpath(protectedPath);
    if (
      canonical === config.cacheRoot ||
      inside(canonical, config.cacheRoot) ||
      inside(config.cacheRoot, canonical)
    )
      throw new Error("Updater cache overlaps a protected path");
  }
  await privateDirectory(config.cacheRoot);
  const channelPath = path.join(config.cacheRoot, "channel.json");
  const channel = { remoteUrl: config.remoteUrl, ref: config.ref };
  const old = await readOptionalJson(channelPath);
  if (old && JSON.stringify(old) !== JSON.stringify(channel))
    throw new Error("Refusing to retarget an existing updater cache");
  if (!old) await atomicJson(channelPath, channel);
  return config;
}

export async function fetchCandidate(config, installedRevision) {
  const repository = path.join(config.cacheRoot, "repository.git");
  try {
    await fs.access(repository);
  } catch {
    await git(config.cacheRoot, ["init", "--bare", repository]);
  }
  // Fixed refspec, no pull/reset, no working-tree mutation, no push operation.
  await git(repository, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    config.remoteUrl,
    `+${config.ref}:refs/discovery/main`,
  ]);
  // A later deployment may come from another local checkout. Prefer objects
  // already fetched from the pinned channel; the local source is only a fallback.
  if (installedRevision) {
    try {
      await git(repository, ["cat-file", "-e", `${revision(installedRevision)}^{commit}`]);
    } catch {
      if (!config.sourceRepository) throw new Error("Installed source revision is unavailable");
      await git(repository, [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        await fs.realpath(config.sourceRepository),
        revision(installedRevision),
      ]);
    }
  }
  return {
    repository,
    candidateRevision: (await git(repository, ["rev-parse", "refs/discovery/main"])).trim(),
  };
}

async function command(commandName, args, cwd, env) {
  await exec(commandName, args, { cwd, env, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000 });
}
export async function checkRenderer({ root, changedPaths }) {
  const env = Object.fromEntries(
    ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  env.HOME = path.join(root, ".discovery-validation", "os-home");
  env.TMPDIR = path.join(root, ".discovery-validation", "tmp");
  await fs.mkdir(env.HOME, { recursive: true, mode: 0o700 });
  await fs.mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
  env.PASEO_HOME = path.join(root, ".discovery-validation", "home");
  env.PASEO_ELECTRON_USER_DATA_DIR = path.join(root, ".discovery-validation", "profile");
  env.npm_config_offline = "true";
  env.PATH = `${path.join(root, "node_modules", ".bin")}${path.delimiter}${env.PATH || ""}`;
  await command("npm", ["run", "typecheck", "--workspace", "@getpaseo/app"], root, env);
  const changed = changedPaths.filter(
    (name) => rendererPath.test(name) && /\.[cm]?[jt]sx?$/.test(name),
  );
  const existing = [];
  for (const name of changed) {
    try {
      await fs.access(path.join(root, name));
      existing.push(name);
    } catch {}
  }
  if (existing.length) {
    await command("npm", ["exec", "--", "oxlint", ...existing], root, env);
    await command("npm", ["exec", "--", "oxfmt", "--check", ...existing], root, env);
    await command(
      "npm",
      [
        "exec",
        "--workspace",
        "@getpaseo/app",
        "--",
        "vitest",
        "related",
        ...existing.map((name) => name.slice("packages/app/".length)),
        "--run",
        "--passWithNoTests",
        "--bail=1",
      ],
      root,
      env,
    );
  }
}

async function checkStagingSpace({ base, cacheRoot, availableBytes, minFreeBytes }) {
  try {
    await fs.access(path.join(base.root, ".discovery-validation"));
    throw new Error("Validation namespace exists in base");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stats = await fs.statfs(cacheRoot);
  let baseBytes = 0;
  for (const name of Object.keys(base.manifest.entries)) {
    const stat = await fs.lstat(path.join(base.root, name));
    if (stat.isFile()) baseBytes += stat.size;
  }
  const free = availableBytes ?? stats.bavail * stats.bsize;
  if (!Number.isFinite(minFreeBytes) || minFreeBytes < 0) throw new Error("Invalid disk reserve");
  if (free < baseBytes + minFreeBytes) throw new Error("Insufficient staging disk reserve");
}

async function overlayRenderer(repository, candidate, staging) {
  const entries = new Map(
    (await tree(repository, candidate.revision)).map((entry) => [entry.name, entry]),
  );
  for (const name of candidate.changedPaths.filter((file) => rendererPath.test(file))) {
    const target = path.resolve(staging, name);
    if (!inside(staging, target)) throw new Error("Unsafe overlay path");
    for (let parent = path.dirname(target); parent !== staging; parent = path.dirname(parent)) {
      try {
        if ((await fs.lstat(parent)).isSymbolicLink())
          throw new Error("Overlay traverses a symbolic link");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const entry = entries.get(name);
    // Only newly copied staging files are removed, never installed artifacts.
    await fs.rm(target, { force: true });
    if (entry) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await git(repository, ["cat-file", "blob", entry.oid], true), {
        mode: entry.mode === "100755" ? 0o755 : 0o644,
      });
    }
  }
}

export async function stageRendererRelease({
  repository,
  candidate,
  current,
  releases,
  cacheRoot,
  minFreeBytes = 8 * 1024 ** 3,
  runChecks = checkRenderer,
  validateLaunch,
  availableBytes,
}) {
  if (candidate.state !== "eligible" || candidate.intent.mode !== "renderer")
    throw new Error("Renderer stage requires verified renderer intent");
  if (typeof validateLaunch !== "function")
    throw new Error("Isolated launch validation is required");
  const base = await verifyRelease(releases, current.id, current.digest);
  const reinspected = await inspectCandidate({
    repository,
    installedRevision: base.manifest.sourceRevision,
    candidateRevision: candidate.revision,
  });
  if (reinspected.state !== "eligible" || reinspected.intent.mode !== "renderer")
    throw new Error("Candidate no longer binds installed base");
  candidate = reinspected;
  const id = `auto-${candidate.revision.slice(0, 16)}-${current.digest.slice(0, 12)}`;
  const destination = path.join(releases, id);
  const existing = await readOptionalJson(path.join(destination, "release.json"));
  if (existing) {
    const digest = manifestDigest(existing);
    const verified = await verifyRelease(releases, id, digest);
    if (
      verified.manifest.sourceRevision !== candidate.revision ||
      verified.manifest.discovery?.baseDigest !== current.digest ||
      !isRendererOnly(base.manifest, verified.manifest)
    )
      throw new Error("Existing staged release does not match candidate");
    return { id, digest };
  }
  await checkStagingSpace({ base, cacheRoot, availableBytes, minFreeBytes });
  const staging = path.join(cacheRoot, `staging-${id}-${crypto.randomUUID()}`);
  await fs.cp(base.root, staging, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  await overlayRenderer(repository, candidate, staging);
  await runChecks({ root: staging, changedPaths: candidate.changedPaths });
  await validateLaunch({ root: staging, candidate, current });
  // This directory is created only by validation in this new staging copy.
  await fs.rm(path.join(staging, ".discovery-validation"), { recursive: true, force: true });
  const manifest = {
    ...base.manifest,
    id,
    sourceRevision: candidate.revision,
    stateCompatibility: "preserve",
    entries: await scanRelease(staging),
    discovery: {
      baseRevision: base.manifest.sourceRevision,
      baseDigest: current.digest,
      intent: candidate.intent,
      changedPaths: candidate.changedPaths,
      overlayPaths: candidate.changedPaths.filter((name) => rendererPath.test(name)),
    },
  };
  if (!isRendererOnly(base.manifest, manifest))
    throw new Error("Renderer validation mutated native or dependency bytes");
  await atomicJson(path.join(staging, "release.json"), manifest);
  await fs.rename(staging, destination);
  const digest = manifestDigest(manifest);
  await verifyRelease(releases, id, digest);
  return { id, digest };
}

export async function queueDiscoveredRelease(control, selection, { baseDigest }) {
  return changeState(control, (state) => {
    if (state.current.digest !== baseDigest || state.transition)
      throw new Error("Installed base changed before discovery queue");
    if (
      state.pending &&
      (state.pending.id !== selection.id || state.pending.digest !== selection.digest)
    )
      throw new Error("Another update is pending");
    return { ...state, pending: selection };
  });
}

export function createDiscovery({
  config,
  control,
  readCurrent,
  fetch = fetchCandidate,
  inspect = inspectCandidate,
  stageRenderer = stageRendererRelease,
  stageFull,
  queue = (selection, context) => queueDiscoveredRelease(control, selection, context),
  validateLaunch,
  now = () => Date.now(),
}) {
  const interval = Math.min(24 * 60 * 60_000, Math.max(60_000, config.pollIntervalMs ?? 300_000));
  const statusFile = path.join(control, "discovery.json");
  let inFlight,
    timer,
    stopped = false;
  async function save(status) {
    await atomicJson(statusFile, status);
    return status;
  }
  async function obtainSelection({ previous, source, current, candidate, status }) {
    let selection;
    if (
      previous?.selection &&
      previous.checkedRevision === source.candidateRevision &&
      previous.baseDigest === current.digest
    ) {
      await verifyRelease(config.releases, previous.selection.id, previous.selection.digest);
      selection = previous.selection;
    } else {
      await save({ ...status, state: "staging" });
      const stage = candidate.intent.mode === "renderer" ? stageRenderer : stageFull;
      if (!stage) throw new Error("full-staging-not-configured");
      selection = await stage({
        ...source,
        candidate,
        current,
        releases: config.releases,
        cacheRoot: config.cacheRoot,
        minFreeBytes: config.minFreeBytes,
        validateLaunch,
      });
      await save({ ...status, state: "staged", selection, mode: candidate.intent.mode });
    }
    const sealed = await verifyRelease(config.releases, selection.id, selection.digest);
    if (sealed.manifest.sourceRevision !== candidate.revision)
      throw new Error("Staged selection is not the discovered revision");
    return selection;
  }
  async function poll() {
    if (!config.enabled) return { state: "disabled" };
    await validateDiscoveryConfig(config);
    const unlock = await acquireLock(config.cacheRoot, "discovery.lock");
    let previous;
    try {
      previous = await readOptionalJson(statusFile);
      const current = await readCurrent();
      if (current.pending || current.transition)
        return save({ ...previous, state: "waiting-for-pending-update", checkedAt: now() });
      const source = await fetch(config, current.manifest.sourceRevision);
      const status = {
        checkedAt: now(),
        checkedRevision: source.candidateRevision,
        baseDigest: current.digest,
        failures: 0,
        nextCheckAt: now() + interval,
      };
      if (
        previous?.state === "rejected" &&
        previous.checkedRevision === source.candidateRevision &&
        previous.baseDigest === current.digest
      )
        return save({ ...previous, ...status, state: "rejected" });
      const candidate = await inspect({
        ...source,
        installedRevision: current.manifest.sourceRevision,
      });
      if (candidate.state !== "eligible") return save({ ...status, ...candidate });
      const selection = await obtainSelection({ previous, source, current, candidate, status });
      if (stopped)
        return save({ ...status, state: "staged", selection, reason: "discovery-stopped" });
      const latest = await readCurrent();
      if (latest.digest !== current.digest || latest.pending || latest.transition)
        return save({
          ...status,
          state: "staged",
          selection,
          reason: "selection-changed-before-queue",
        });
      await queue(selection, {
        baseDigest: current.digest,
        mode: candidate.intent.mode,
        candidateRevision: candidate.revision,
      });
      return save({ ...status, state: "queued", selection, mode: candidate.intent.mode });
    } catch (error) {
      const durable = await readOptionalJson(statusFile);
      const failures = (previous?.failures ?? 0) + 1;
      let failureState = "error";
      if (durable?.state === "staging") failureState = "rejected";
      if (durable?.selection) failureState = "staged";
      return save({
        ...durable,
        state: failureState,
        reason: error.message,
        checkedAt: now(),
        failures,
        nextCheckAt: now() + Math.min(3_600_000, interval * 2 ** Math.min(failures, 6)),
      });
    } finally {
      await unlock();
    }
  }
  function pollOnce() {
    if (!inFlight)
      inFlight = poll().finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }
  async function tick() {
    let status;
    try {
      status = await pollOnce();
    } catch {
      /* Configuration/lock failure: do not queue. */
    }
    if (!stopped) {
      timer = setTimeout(
        tick,
        Math.max(interval, (status?.nextCheckAt ?? now() + interval) - now()),
      );
      timer.unref?.();
    }
  }
  return {
    pollOnce,
    start() {
      if (timer || inFlight) return;
      stopped = false;
      void tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
