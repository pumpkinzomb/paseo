import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireLock,
  atomicJson,
  privateDirectory,
  readOptionalJson,
  inside,
} from "./dev-update-store.mjs";

const modulePath = fileURLToPath(import.meta.url);
export function validationEnvironment(fixture, inherited = process.env) {
  const env = {};
  for (const key of ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"])
    if (inherited[key]) env[key] = inherited[key];
  return {
    ...env,
    HOME: path.join(fixture, "os-home"),
    TMPDIR: path.join(fixture, "tmp"),
    CI: "1",
    EXPO_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    npm_config_offline: "true",
  };
}
async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function bounded(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(check, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error.message;
    }
    await delay(300);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ""}`);
}
async function evaluate(target, expression) {
  const websocket = new WebSocket(target);
  try {
    await bounded(
      new Promise((resolve, reject) => {
        websocket.addEventListener("open", resolve, { once: true });
        websocket.addEventListener(
          "error",
          () => reject(new Error("Local CDP connection failed")),
          { once: true },
        );
      }),
      5000,
      "Local CDP open timed out",
    );
    return await bounded(
      new Promise((resolve, reject) => {
        websocket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== 1) return;
          if (message.error || message.result?.exceptionDetails)
            reject(new Error("Candidate renderer evaluation failed"));
          else resolve(message.result?.result?.value);
        });
        websocket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      }),
      5000,
      "Candidate renderer evaluation timed out",
    );
  } finally {
    websocket.close();
  }
}
export async function inspectHydratedRenderer({ config, timeoutMs = 120_000 }) {
  const origin = `http://localhost:${config.metroPort}`;
  let lastRoute,
    stable = 0;
  return waitFor(
    async () => {
      const port = Number(
        (await fs.readFile(path.join(config.userData, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      );
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("Invalid private CDP port");
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === "page" && new URL(target.url).origin === origin,
      );
      if (!page) return false;
      const socket = new URL(page.webSocketDebuggerUrl);
      if (
        !["127.0.0.1", "localhost"].includes(socket.hostname) ||
        socket.port !== String(port) ||
        socket.protocol !== "ws:"
      )
        throw new Error("CDP target escaped private local endpoint");
      const sample = await evaluate(
        socket.href,
        `(() => {
      const root = document.querySelector('#root');
      const hydrated = root && Array.from(root.querySelectorAll('*')).slice(0, 100).some(e => Object.keys(e).some(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')));
      const controls = !!root?.querySelector('button, [role="button"], input, textarea');
      const failed = /Failed to compile|Unable to resolve module|Uncaught Error|Something went wrong/.test(document.body?.innerText || '');
      return { ready: document.readyState === 'complete' && !!hydrated && controls && !failed, route: location.pathname, origin: location.origin };
    })()`,
      );
      if (!sample?.ready || sample.origin !== origin) {
        stable = 0;
        return false;
      }
      stable = sample.route === lastRoute ? stable + 1 : 1;
      lastRoute = sample.route;
      return stable >= 3 ? { route: sample.route, hydrated: true } : false;
    },
    timeoutMs,
    "Hydrated candidate UI",
  );
}

// Port-injected lifecycle used by focused tests. Production invokes it only in
// the empty-HOME subprocess below, never in the running supervisor process.
export async function validateWithPorts({
  config,
  root,
  control,
  launch,
  inspect,
  readDaemon,
  timeoutMs = 120_000,
}) {
  let runtime, result, failure;
  const cleanupErrors = [];
  try {
    runtime = await launch(config, root, control);
    if (typeof runtime.requestQuit !== "function")
      throw new Error("Runtime lacks owned normal-quit validation API");
    await bounded(runtime.ready(), timeoutMs, "Candidate desktop/daemon readiness timed out");
    const daemon = await readDaemon();
    if (daemon?.serverId !== config.serverId || daemon.listen !== `127.0.0.1:${config.daemonPort}`)
      throw new Error("Candidate daemon identity/listen mismatch");
    result = await inspect({ config, timeoutMs });
    if (result?.hydrated !== true) throw new Error("Candidate UI did not hydrate");
  } catch (error) {
    failure = error;
  } finally {
    if (runtime) {
      try {
        await bounded(runtime.requestQuit(), 30_000, "Candidate normal quit timed out");
        await bounded(runtime.exited, 30_000, "Candidate desktop remained after quit");
      } catch (error) {
        cleanupErrors.push(error.message);
      }
      try {
        await bounded(runtime.stopMetro(), 15_000, "Candidate Metro remained after stop");
      } catch (error) {
        cleanupErrors.push(error.message);
      }
      try {
        await waitFor(async () => !(await readDaemon()), 15_000, "Candidate daemon shutdown");
      } catch (error) {
        cleanupErrors.push(error.message);
      }
    }
  }
  if (failure || cleanupErrors.length) {
    const error = new Error([failure?.message, ...cleanupErrors].filter(Boolean).join("; "));
    error.retainedProcesses = !runtime || cleanupErrors.length > 0;
    throw error;
  }
  return {
    ...result,
    desktopReady: true,
    daemonReady: true,
    normalQuit: true,
    retainedProcesses: false,
  };
}

async function worker(root, fixture) {
  if (process.env.HOME !== path.join(fixture, "os-home"))
    throw new Error("Validation requires an empty isolated HOME worker");
  const home = path.join(fixture, "home"),
    userData = path.join(fixture, "profile"),
    control = path.join(fixture, "control");
  const { getOrCreateServerId } = await import(
    pathToFileURL(path.join(root, "packages/server/dist/server/server/server-id.js"))
  );
  const { readDaemonInstance } = await import(
    pathToFileURL(path.join(root, "packages/server/dist/server/server/daemon-instance.js"))
  );
  const { launchRuntime } = await import("./dev-update-runtime.mjs");
  const daemonPort = await freePort();
  let metroPort = await freePort();
  while (metroPort === daemonPort) metroPort = await freePort();
  const config = {
    schemaVersion: 1,
    releases: path.dirname(root),
    home,
    userData,
    serverId: getOrCreateServerId(home, { env: {} }),
    daemonPort,
    metroPort,
    enableLocalInspection: true,
  };
  await atomicJson(path.join(home, "config.json"), {
    version: 1,
    daemon: {
      listen: `127.0.0.1:${daemonPort}`,
      cors: { allowedOrigins: [`http://localhost:${metroPort}`, `http://127.0.0.1:${metroPort}`] },
      relay: { enabled: false },
    },
  });
  await atomicJson(path.join(fixture, "config.json"), config);
  if (await readDaemonInstance(home))
    throw new Error("Validation home unexpectedly contains a daemon");
  const result = await validateWithPorts({
    config,
    root,
    control,
    launch: launchRuntime,
    inspect: inspectHydratedRenderer,
    readDaemon: () => readDaemonInstance(home),
  });
  await atomicJson(path.join(fixture, "result.json"), { ok: true, ...result, fixture });
}

function validateWorkRoot(root, workRoot) {
  if (!workRoot || !path.isAbsolute(workRoot))
    throw new Error("Private isolated validation workRoot is required");
  if (root === workRoot || inside(root, workRoot) || inside(workRoot, root))
    throw new Error("Validation workRoot must not overlap candidate source");
}

export async function validateCandidateLaunch({
  root,
  workRoot,
  timeoutMs = 300_000,
  minFreeBytes = 512 * 1024 ** 2,
}) {
  root = await fs.realpath(root);
  validateWorkRoot(root, workRoot);
  await privateDirectory(workRoot);
  const unlock = await acquireLock(workRoot, "validation.lock");
  let fixture,
    retainLock = false;
  try {
    const stats = await fs.statfs(workRoot);
    if (stats.bavail * stats.bsize < minFreeBytes)
      throw new Error("Insufficient validation disk reserve");
    fixture = path.join(workRoot, `validation-${crypto.randomUUID()}`);
    await privateDirectory(fixture);
    for (const name of ["os-home", "tmp", "home", "profile", "control"])
      await privateDirectory(path.join(fixture, name));
    const log = await fs.open(path.join(fixture, "worker.log"), "wx", 0o600);
    const child = spawn(process.execPath, [modulePath, "--worker", root, fixture], {
      env: validationEnvironment(fixture),
      cwd: fixture,
      stdio: ["ignore", log.fd, log.fd],
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await log.close();
    await atomicJson(path.join(fixture, "worker.json"), { pid: child.pid, root });
    let exit;
    try {
      exit = await bounded(
        exited,
        Math.max(30_000, Math.min(timeoutMs, 600_000)),
        "Validation worker timed out; fixture retained, no force-kill attempted",
      );
    } catch (error) {
      retainLock = true;
      child.unref();
      throw error;
    }
    const result = await readOptionalJson(path.join(fixture, "result.json"));
    if (result?.retainedProcesses !== false) retainLock = true;
    if (exit.code !== 0 || result?.ok !== true)
      throw new Error(
        result?.error || "Candidate validation worker failed; inspect retained fixture",
      );
    return result;
  } catch (error) {
    throw new Error(`${error.message}${fixture ? `; fixture: ${fixture}` : ""}`, { cause: error });
  } finally {
    if (!retainLock) await unlock();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === modulePath &&
  process.argv[2] === "--worker"
) {
  const [, , , root, fixture] = process.argv;
  try {
    await worker(root, fixture);
  } catch (error) {
    await atomicJson(path.join(fixture, "result.json"), {
      ok: false,
      error: error.message,
      retainedProcesses: error.retainedProcesses ?? true,
      fixture,
    });
    process.exitCode = 1;
  }
}
