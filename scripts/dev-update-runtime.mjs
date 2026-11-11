import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  atomicJson,
  privateDirectory,
  readJson,
  readOptionalJson,
  verifyRelease,
  isRendererOnly,
  acquireLock,
  changeState,
} from "./dev-update-store.mjs";

export function runtimeEnvironment(
  config,
  generationDirectory,
  generation,
  inherited = process.env,
) {
  const env = { ...inherited };
  for (const key of Object.keys(env))
    if (/^(PASEO_|EXPO_)/.test(key) || key === "ELECTRON_RUN_AS_NODE" || key === "NODE_OPTIONS")
      delete env[key];
  Object.assign(env, {
    PASEO_HOME: config.home,
    PASEO_LISTEN: `127.0.0.1:${config.daemonPort}`,
    PASEO_DAEMON_ENDPOINT: `localhost:${config.daemonPort}`,
    PASEO_ELECTRON_USER_DATA_DIR: config.userData,
    EXPO_DEV_URL: `http://localhost:${config.metroPort}`,
    PASEO_NODE_ENV: "development",
    PASEO_WEB_PLATFORM: "electron",
    EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL: "supervised-runtime",
    BROWSER: "none",
    APP_VARIANT: "development",
    PASEO_DEV_UPDATE_CONTROL_DIR: generationDirectory,
    PASEO_DEV_UPDATE_GENERATION: generation,
  });
  if (config.enableLocalInspection === true) env.PASEO_ELECTRON_FLAGS = "--remote-debugging-port=0";
  if (config.selfDevelopmentPolicy)
    env.PASEO_SELF_DEVELOPMENT_POLICY = JSON.stringify(config.selfDevelopmentPolicy);
  return env;
}
export function validateConfig(config) {
  if (config.schemaVersion !== 1) throw new Error("Unsupported supervisor configuration");
  for (const key of ["releases", "home", "userData"])
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key]))
      throw new Error(`Configuration ${key} must be an absolute path`);
  for (const key of ["daemonPort", "metroPort"])
    if (!Number.isInteger(config[key]) || config[key] < 1024 || config[key] > 65535)
      throw new Error(`Invalid ${key}`);
  if (config.daemonPort === config.metroPort) throw new Error("Runtime ports collide");
  if (
    config.enableLocalInspection !== undefined &&
    typeof config.enableLocalInspection !== "boolean"
  )
    throw new Error("Invalid local inspection option");
  if (typeof config.serverId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(config.serverId))
    throw new Error("Expected existing daemon serverId is required");
}
export async function validateRuntimePaths(config, control) {
  async function canonicalFuture(value) {
    try {
      return await fs.realpath(value);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(value);
      if (parent === value) throw error;
      return path.join(await canonicalFuture(parent), path.basename(value));
    }
  }
  const values = [control, config.releases, config.home, config.userData];
  for (const value of values)
    if ((await canonicalFuture(value)) !== path.resolve(value))
      throw new Error("Runtime path aliases are not allowed");
  for (let a = 0; a < values.length; a++)
    for (let b = a + 1; b < values.length; b++) {
      const relative = path.relative(values[a], values[b]);
      const reverse = path.relative(values[b], values[a]);
      const nested = (value) =>
        value === "" ||
        (!value.startsWith(`..${path.sep}`) && value !== ".." && !path.isAbsolute(value));
      if (nested(relative) || nested(reverse))
        throw new Error("Runtime release, control and state directories must not overlap");
    }
}
async function portFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(new Error(`Port ${port} is already occupied; no process was stopped`)),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
export function spawnOwned(command, args, options) {
  const child = spawn(command, args, options);
  let settled = false;
  let outcome = null;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      outcome = { error: error.message };
    });
    child.once("close", (code, signal) => {
      settled = true;
      outcome ??= { code, signal };
      resolve(outcome);
    });
  });
  return {
    child,
    closed,
    get closedAlready() {
      return settled;
    },
    get outcome() {
      return outcome;
    },
  };
}
async function stopOwned(process, label) {
  if (process.closedAlready) return;
  process.child.kill("SIGTERM");
  const stopped = await Promise.race([
    process.closed.then(() => true),
    delay(10_000).then(() => false),
  ]);
  if (!stopped) throw new Error(`${label} did not exit; no force-kill or replacement attempted`);
}
async function waitForMetro(port, owned) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (owned.closedAlready) throw new Error(`Metro exited: ${JSON.stringify(owned.outcome)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok && (await response.text()).includes("packager-status:running")) return;
    } catch {
      /* Startup has not bound its port yet. */
    }
    await delay(500);
  }
  throw new Error("Metro readiness timed out");
}
export async function daemonSnapshot(root, home) {
  const { readDaemonInstance } = await import(
    pathToFileURL(path.join(root, "packages/server/dist/server/server/daemon-instance.js"))
  );
  return readDaemonInstance(home);
}
function sameDaemon(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
class Supervisor {
  runtime = null;
  launchAttempted = false;
  pendingCache = null;
  handoff = null;
  lastStatus = null;

  constructor(control, config, deps) {
    this.control = control;
    this.config = config;
    this.deps = deps;
  }
  async status(value) {
    const key = JSON.stringify(value);
    if (key === this.lastStatus) return;
    await atomicJson(path.join(this.control, "status.json"), value);
    this.lastStatus = key;
  }
  inspectDaemon() {
    return this.deps.inspectDaemon(this.release.root, this.config.home);
  }
  async launch(root, daemonHandoff = null) {
    this.launchAttempted = true;
    this.runtime = await this.deps.launch(this.config, root, this.control, { daemonHandoff });
    await this.runtime.ready();
  }
  async initialize() {
    const state = await readJson(path.join(this.control, "state.json"));
    if (state.schemaVersion !== 1 || state.transition)
      throw new Error("Interrupted update needs operator reconciliation; nothing launched");
    this.release = await verifyRelease(
      this.config.releases,
      state.current.id,
      state.current.digest,
    );
    this.selection = state.current;
    const existing = await this.inspectDaemon();
    if (existing) {
      if (
        !state.bootstrap ||
        state.bootstrap.selectionDigest !== this.selection.digest ||
        !sameDaemon(state.bootstrap.instance, existing)
      )
        throw new Error(
          "Initial supervisor start requires the prior desktop and daemon to be normally stopped; no existing daemon was adopted",
        );
    } else if (state.bootstrap)
      throw new Error("Explicit bootstrap daemon is no longer running; reconcile before starting");
    await this.launch(this.release.root, existing);
    if (existing && !sameDaemon(existing, await this.inspectDaemon()))
      throw new Error("Bootstrap daemon identity changed during startup");
    if (state.bootstrap)
      await changeState(this.control, (current) => {
        if (
          current.bootstrap?.selectionDigest !== this.selection.digest ||
          current.current.digest !== this.selection.digest
        )
          throw new Error("Bootstrap ownership changed");
        const { bootstrap: _bootstrap, ...remaining } = current;
        return remaining;
      });
    await this.status({ state: "running", releaseId: this.selection.id });
  }
  async stopAfterExit(status) {
    await this.runtime.stopMetro();
    this.runtime = null;
    if (status) await this.status(status);
    return true;
  }
  async waitForHandoff(pending, uiOnly) {
    if (uiOnly && !this.handoff) {
      this.handoff = { requestId: pending.id, daemon: await this.inspectDaemon() };
      await this.runtime.requestHandoff(pending.id);
    }
    await this.status({
      state: uiOnly ? "waiting-for-windows" : "waiting-for-app-quit",
      releaseId: this.selection.id,
      pendingReleaseId: pending.id,
      message: uiOnly
        ? "Close Paseo windows to apply safely; drafts and browser guests are never discarded."
        : "Full update will relaunch after a normal app quit and daemon shutdown. Active work is not interrupted.",
    });
  }
  async validateExitHandoff(daemonBefore) {
    if (!this.handoff) return;
    const receipt = await this.runtime.handoffResult(this.handoff.requestId);
    if (receipt?.state === "ready") {
      if (!sameDaemon(this.handoff.daemon, daemonBefore))
        throw new Error("Daemon identity changed across acknowledged UI handoff");
    } else if (daemonBefore)
      throw new Error(
        "Desktop exited without a matching safe handoff receipt while daemon remains running",
      );
  }
  async applyAfterExit(exit, pending, candidate, uiOnly) {
    if (exit.code !== 0 || exit.signal)
      return this.stopAfterExit({
        state: "interrupted",
        pendingReleaseId: pending.id,
        message: "Desktop did not quit normally; update remains pending.",
      });
    const daemonBefore = await this.inspectDaemon();
    await this.validateExitHandoff(daemonBefore);
    if (!uiOnly && daemonBefore)
      return this.stopAfterExit({
        state: "waiting-for-daemon-stop",
        pendingReleaseId: pending.id,
        message:
          "Daemon is still running (for example Keep running after quit); no code switch or process stop was attempted.",
      });
    await changeState(this.control, (current) => {
      if (
        current.current.digest !== this.selection.digest ||
        current.pending?.digest !== pending.digest
      )
        throw new Error("Update selection raced");
      return {
        ...current,
        transition: {
          from: this.selection,
          to: pending,
          kind: uiOnly ? "renderer" : "full",
          phase: "starting",
        },
      };
    });
    await this.runtime.stopMetro();
    this.runtime = null;
    await verifyRelease(this.config.releases, pending.id, pending.digest);
    if (!sameDaemon(daemonBefore, await this.inspectDaemon()))
      throw new Error("Daemon identity changed during handoff");
    await this.launch(candidate.root, uiOnly ? daemonBefore : null);
    if (uiOnly && daemonBefore && !sameDaemon(daemonBefore, await this.inspectDaemon()))
      throw new Error("UI-only update changed daemon identity");
    await changeState(this.control, (current) => {
      if (
        current.transition?.to.digest !== pending.digest ||
        current.current.digest !== this.selection.digest
      )
        throw new Error("Update commit lost ownership");
      return {
        schemaVersion: 1,
        current: pending,
        previous: this.selection,
        pending: null,
        transition: null,
      };
    });
    this.selection = pending;
    this.release = candidate;
    this.handoff = null;
    await this.status({ state: "running", releaseId: this.selection.id, updated: true });
    return false;
  }
  async tick() {
    const outcome = await Promise.race([
      this.runtime.exited.then((exit) => ({ exit })),
      this.runtime.failure ?? new Promise(() => {}),
      delay(this.deps.pollMs).then(() => null),
    ]);
    if (outcome?.failure) throw new Error(outcome.failure);
    const state = await readJson(path.join(this.control, "state.json"));
    if (
      state.current.id !== this.selection.id ||
      state.current.digest !== this.selection.digest ||
      state.transition
    )
      throw new Error("Selection changed outside supervisor");
    if (!state.pending)
      return outcome
        ? this.stopAfterExit({ state: "stopped", releaseId: this.selection.id, exit: outcome.exit })
        : false;
    const pending = state.pending;
    if (
      !this.pendingCache ||
      this.pendingCache.digest !== pending.digest ||
      this.pendingCache.id !== pending.id
    )
      this.pendingCache = {
        ...pending,
        release: await verifyRelease(this.config.releases, pending.id, pending.digest),
      };
    const candidate = this.pendingCache.release;
    const uiOnly = isRendererOnly(this.release.manifest, candidate.manifest);
    if (outcome) return this.applyAfterExit(outcome.exit, pending, candidate, uiOnly);
    await this.waitForHandoff(pending, uiOnly);
    return false;
  }
}
export async function runSupervisor(
  control,
  { launch = launchRuntime, inspectDaemon = daemonSnapshot, pollMs = 1_000 } = {},
) {
  await privateDirectory(control);
  const config = await readJson(path.join(control, "config.json"));
  validateConfig(config);
  await validateRuntimePaths(config, control);
  const unlock = await acquireLock(control, "supervisor.lock");
  const supervisor = new Supervisor(control, config, { launch, inspectDaemon, pollMs });
  let safeToUnlock = true;
  try {
    await supervisor.initialize();
    while (!(await supervisor.tick())) {
      /* Await an owned child exit or pending update. */
    }
  } catch (error) {
    // Never kill a candidate UI/daemon to manufacture a successful rollback.
    safeToUnlock = !supervisor.launchAttempted || Boolean(supervisor.runtime?.isExited());
    await supervisor.status({ state: "recovery-required", message: error.message }).catch(() => {});
    throw error;
  } finally {
    if (safeToUnlock) await unlock();
  }
}
export function matchesDaemonOwnership(receipt, generation, instance) {
  return Boolean(
    receipt?.schemaVersion === 1 &&
    receipt.generation === generation &&
    receipt.instance &&
    ["pid", "startedAt", "uid", "hostname", "serverId", "desktopManaged", "listen"].every(
      (key) => receipt.instance[key] === instance[key],
    ),
  );
}
export async function captureBootstrapDaemon(config, release, inspect = daemonSnapshot) {
  const instance = await inspect(release.root, config.home);
  if (
    !instance ||
    !instance.desktopManaged ||
    instance.listen !== `127.0.0.1:${config.daemonPort}` ||
    instance.serverId !== config.serverId ||
    (process.getuid && instance.uid !== process.getuid())
  )
    throw new Error(
      "Cannot capture a ready same-user desktop-managed daemon with the configured identity",
    );
  return { selectionDigest: release.digest, instance };
}
export function electronExecutable(root) {
  const names = { darwin: "Electron.app/Contents/MacOS/Electron", win32: "electron.exe" };
  return path.join(root, "node_modules/electron/dist", names[process.platform] ?? "electron");
}
export function validateManagedSettings(config, persisted) {
  const expected = `127.0.0.1:${config.daemonPort}`;
  if ((persisted.daemon?.listen ?? "127.0.0.1:6767") !== expected)
    throw new Error(
      `Managed daemon persisted listen must be ${expected}; environment overrides are intentionally ignored`,
    );
  const origins = persisted.daemon?.cors?.allowedOrigins ?? [];
  if (!origins.includes("*") && !origins.includes(`http://localhost:${config.metroPort}`))
    throw new Error(
      "Managed daemon persisted CORS does not allow this Metro origin; use the supported settings flow with user approval",
    );
}
async function assertManagedConfiguration(config, root) {
  const { readPersistedConfig } = await import(
    pathToFileURL(path.join(root, "packages/server/dist/server/server/persisted-config.js"))
  );
  validateManagedSettings(config, readPersistedConfig(config.home));
}
export async function assertRuntimeArtifacts(root) {
  await fs.access(electronExecutable(root), 1);
  for (const relative of [
    "packages/desktop/dist/main.js",
    "packages/desktop/dist/preload.js",
    "packages/server/dist/scripts/supervisor-entrypoint.js",
    "node_modules/expo/bin/cli",
    "packages/app/package.json",
  ])
    await fs.access(path.join(root, relative), 4);
}
export async function launchRuntime(config, root, control, { daemonHandoff = null } = {}) {
  await assertRuntimeArtifacts(root);
  await assertManagedConfiguration(config, root);
  await portFree(config.metroPort);
  const generation = crypto.randomUUID();
  const generationDirectory = path.join(control, `generation-${generation}`);
  await privateDirectory(generationDirectory);
  const env = runtimeEnvironment(config, generationDirectory, generation);
  if (daemonHandoff)
    await atomicJson(path.join(generationDirectory, "daemon-handoff.json"), {
      schemaVersion: 1,
      generation,
      home: config.home,
      instance: daemonHandoff,
    });
  const log = await fs.open(path.join(control, "runtime.log"), "a", 0o600);
  const stdio = ["ignore", log.fd, log.fd];
  const metro = spawnOwned(
    process.execPath,
    [path.join(root, "node_modules/expo/bin/cli"), "start", "--port", String(config.metroPort)],
    { cwd: path.join(root, "packages/app"), env, stdio },
  );
  let desktop;
  try {
    await waitForMetro(config.metroPort, metro);
    desktop = spawnOwned(electronExecutable(root), [path.join(root, "packages/desktop")], {
      cwd: root,
      env,
      stdio,
    });
    await atomicJson(path.join(generationDirectory, "processes.json"), {
      generation,
      root,
      metroPid: metro.child.pid,
      desktopPid: desktop.child.pid,
    });
  } catch (error) {
    await stopOwned(metro, "Metro");
    throw error;
  } finally {
    await log.close();
  }
  async function ownershipAcknowledged() {
    if (!daemonHandoff) return true;
    const ownership = await readOptionalJson(path.join(generationDirectory, "daemon-owned.json"));
    if (!ownership) return false;
    if (!matchesDaemonOwnership(ownership, generation, daemonHandoff))
      throw new Error("Desktop did not acknowledge the exact retained daemon ownership");
    return true;
  }
  return {
    exited: desktop.closed,
    failure: metro.closed.then(() => ({
      failure: "Metro exited while supervised desktop was running",
    })),
    isExited: () => desktop.closedAlready && metro.closedAlready,
    stopMetro: () => stopOwned(metro, "Metro"),
    requestQuit: () => stopOwned(desktop, "Desktop"),
    async requestHandoff(requestId) {
      const file = path.join(generationDirectory, "request.json");
      const existing = await readOptionalJson(file);
      if (!existing) await atomicJson(file, { schemaVersion: 1, generation, requestId });
      else if (existing.requestId !== requestId) throw new Error("Handoff already in progress");
    },
    async handoffResult(requestId) {
      const receipt = await readOptionalJson(path.join(generationDirectory, "result.json"));
      return receipt?.schemaVersion === 1 &&
        receipt.generation === generation &&
        receipt.requestId === requestId
        ? receipt
        : null;
    },
    async ready() {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (desktop.closedAlready || metro.closedAlready)
          throw new Error("Runtime exited before readiness");
        const health = await readOptionalJson(path.join(generationDirectory, "started.json"));
        if (
          health?.schemaVersion === 1 &&
          health.generation === generation &&
          health.state === "ready"
        ) {
          const daemon = await daemonSnapshot(root, config.home);
          if (daemon?.serverId && daemon.serverId !== config.serverId)
            throw new Error("Daemon identity differs from configured state");
          if (daemon?.listen && daemon.listen !== `127.0.0.1:${config.daemonPort}`)
            throw new Error("Daemon started on a different listen address than configured");
          if (
            daemon?.serverId === config.serverId &&
            daemon.listen === `127.0.0.1:${config.daemonPort}` &&
            (await ownershipAcknowledged())
          )
            return;
        }
        await delay(250);
      }
      throw new Error(
        "Desktop readiness timed out; retained processes and previous selection for inspection",
      );
    },
  };
}
