import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const control = path.join(os.homedir(), "workspaces/paseo/.dev/runtime-control");
// Supervised installations use sealed releases, not legacy UI hash metadata.
const supervised = path.join(control, "supervised");
if (
  await fs.stat(path.join(supervised, "state.json")).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  )
) {
  const config = JSON.parse(await fs.readFile(path.join(supervised, "config.json"), "utf8"));
  const state = JSON.parse(await fs.readFile(path.join(supervised, "state.json"), "utf8"));
  const releases = await fs.realpath(path.join(os.homedir(), "workspaces/paseo/.dev/runtimes"));
  if (config.releases !== releases) throw new Error("Unexpected supervised release store");
  const { verifyRelease } = await import("./dev-update-store.mjs");
  await verifyRelease(releases, state.current.id, state.current.digest);
  if (process.argv.includes("--check")) {
    if (state.previous) await verifyRelease(releases, state.previous.id, state.previous.digest);
    console.log("Supervised release verification complete; no processes started.");
  } else {
    const child = spawn(
      process.execPath,
      [path.join(supervised, "controller/dev-update.mjs"), "start", "--control", supervised],
      { stdio: "inherit" },
    );
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) throw new Error("Supervised startup failed");
  }
  process.exit(0);
}
const cfg = JSON.parse(await fs.readFile(path.join(control, "active.json"), "utf8"));
const root = await fs.realpath(cfg.release),
  allowed = await fs.realpath(path.join(os.homedir(), "workspaces/paseo/.dev/runtimes"));
if (!root.startsWith(allowed + path.sep)) throw new Error("Unapproved runtime location");
const manifest = JSON.parse(await fs.readFile(path.join(root, "release.json"), "utf8"));
for (const [f, h] of Object.entries(manifest.artifacts))
  if (
    crypto
      .createHash("sha256")
      .update(await fs.readFile(path.join(root, f)))
      .digest("hex") !== h
  )
    throw new Error("Runtime changed: " + f);
for (const [f, h] of Object.entries(cfg.uiSourceHashes))
  if (
    crypto
      .createHash("sha256")
      .update(await fs.readFile(path.join(root, f)))
      .digest("hex") !== h
  )
    throw new Error("Runtime UI changed: " + f);
const daemonRoot = await fs.realpath(cfg.daemonRelease ?? root);
if (!daemonRoot.startsWith(allowed + path.sep)) throw new Error("Unapproved daemon location");
const daemonManifest = JSON.parse(await fs.readFile(path.join(daemonRoot, "release.json"), "utf8"));
for (const [f, h] of Object.entries(daemonManifest.artifacts))
  if (
    crypto
      .createHash("sha256")
      .update(await fs.readFile(path.join(daemonRoot, f)))
      .digest("hex") !== h
  )
    throw new Error("Daemon runtime changed: " + f);
console.log("Independent stable runtime verified.");
if (process.argv.includes("--check")) process.exit(0);
const env = {
  ...process.env,
  PASEO_HOME: cfg.home,
  PASEO_LISTEN: "127.0.0.1:6768",
  PASEO_DAEMON_ENDPOINT: "localhost:6768",
  PASEO_ELECTRON_USER_DATA_DIR: cfg.userData,
  EXPO_DEV_URL: "http://localhost:8084",
  EXPO_PUBLIC_LOCAL_DAEMON: "localhost:6768",
  EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL: "stable-runtime",
  PASEO_ELECTRON_FLAGS: "--remote-debugging-port=0",
  PASEO_NODE_ENV: "development",
  BROWSER: "none",
  APP_VARIANT: "development",
  PASEO_WEB_PLATFORM: "electron",
};
for (const k of [
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "PASEO_DEV_SEED_HOME",
  "PASEO_DEV_RESET_HOME",
])
  delete env[k];
const { readDaemonInstance, startDaemonInstance } = await import(
  pathToFileURL(path.join(daemonRoot, "packages/server/dist/server/server/daemon-instance.js"))
);
let instance = await readDaemonInstance(cfg.home);
if (!instance) {
  const daemonEnv = {};
  for (const k of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "PATH"])
    if (process.env[k]) daemonEnv[k] = process.env[k];
  daemonEnv.PASEO_NODE_ENV = "development";
  daemonEnv.ELECTRON_RUN_AS_NODE = "1";
  if (cfg.selfDevelopmentPolicy)
    daemonEnv.PASEO_SELF_DEVELOPMENT_POLICY = JSON.stringify(cfg.selfDevelopmentPolicy);
  instance = (
    await startDaemonInstance({
      home: cfg.home,
      command: path.join(
        daemonRoot,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [path.join(daemonRoot, "packages/server/dist/scripts/supervisor-entrypoint.js")],
      env: daemonEnv,
      mode: "managed",
      desktopManaged: true,
      timeoutMs: 60000,
    })
  ).instance;
}

if (instance.serverId !== cfg.serverId)
  throw new Error("Different daemon identity; refusing attach");
const stateFile = path.join(control, "ui-processes.json");
let old = {};
try {
  old = JSON.parse(await fs.readFile(stateFile, "utf8"));
} catch {}
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const portOpen = () =>
  new Promise((r) => {
    const s = net.connect({ host: "127.0.0.1", port: 8084 });
    s.on("connect", () => {
      s.destroy();
      r(true);
    });
    s.on("error", () => r(false));
  });
let metroPid;
if (await portOpen()) {
  if (old.release !== root || !old.metroPid || !isAlive(old.metroPid))
    throw new Error("8084 in use by unknown process; nothing stopped");
  metroPid = old.metroPid;
} else {
  const log = await fs.open(path.join(control, "metro.log"), "a");
  const child = spawn(
    process.execPath,
    [path.join(root, "node_modules/expo/bin/cli"), "start", "--port", "8084"],
    {
      cwd: path.join(root, "packages/app"),
      env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  child.unref();
  metroPid = child.pid;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (await portOpen()) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready)
    throw new Error("Stable UI server did not become ready; existing daemon was not changed");
}
const log = await fs.open(path.join(control, "electron.log"), "a");
const ui = spawn(
  path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  [path.join(root, "packages/desktop"), cfg.deepLink],
  { cwd: root, env, detached: true, stdio: ["ignore", log.fd, log.fd] },
);
ui.unref();
await fs.writeFile(stateFile, JSON.stringify({ release: root, metroPid, uiPid: ui.pid }, null, 2));
console.log("Opened stable UI attached to existing daemon; no rebuild performed.");
