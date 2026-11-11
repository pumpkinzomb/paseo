#!/usr/bin/env node
// Build/output separation, not an OS or agent security sandbox.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}
export function resolvePlan(root, manifest) {
  root = fs.realpathSync(root);
  if (manifest.role !== "development-lab" || fs.realpathSync(manifest.root) !== root)
    throw new Error("Lab identity mismatch");
  for (const protectedRoot of manifest.protectedRoots) {
    const resolved = fs.realpathSync(protectedRoot);
    if (root === resolved || inside(resolved, root) || inside(root, resolved))
      throw new Error("Lab overlaps a protected runtime/source");
  }
  const { daemonPort, metroPort } = manifest;
  for (const port of [daemonPort, metroPort])
    if (
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      [6767, 6768, 8081, 8082, 8084].includes(port)
    )
      throw new Error("Unsafe lab port");
  if (daemonPort === metroPort) throw new Error("Ports collide");
  const state = path.join(root, ".lab");
  return {
    root,
    state,
    home: path.join(state, "paseo-home"),
    userData: path.join(state, ".dev", "user-data"),
    daemonPort,
    metroPort,
    protectedRoots: manifest.protectedRoots.map((protectedRoot) => fs.realpathSync(protectedRoot)),
  };
}
export function assertLocalPaths(plan) {
  if (fs.existsSync(path.join(plan.root, ".dependencies-pruned.json")))
    throw new Error(
      "Disposable dependencies were reclaimed; restore the recorded verified copy before launching this lab",
    );
  for (const rel of [
    ".lab",
    ".lab/paseo-home",
    ".lab/.dev",
    ".lab/.dev/user-data",
    "node_modules",
    "packages",
    "packages/server/dist",
    "packages/client/dist",
    "packages/protocol/dist",
    "packages/desktop/dist",
  ]) {
    const candidate = path.join(plan.root, rel);
    if (fs.existsSync(candidate) && !inside(plan.root, fs.realpathSync(candidate)))
      throw new Error(`Path escapes lab: ${rel}`);
  }
  const links = path.join(plan.root, "node_modules/@getpaseo");
  if (fs.existsSync(links))
    for (const name of fs.readdirSync(links)) {
      if (!inside(plan.root, fs.realpathSync(path.join(links, name))))
        throw new Error(`Workspace dependency escapes lab: ${name}`);
    }
}
export function labEnv(plan, inherited) {
  const env = { ...inherited };
  for (const key of Object.keys(env))
    if (
      key.startsWith("PASEO_") ||
      key.startsWith("EXPO_") ||
      key === "ELECTRON_RUN_AS_NODE" ||
      key === "NODE_OPTIONS"
    )
      delete env[key];
  Object.assign(env, {
    PASEO_SELF_DEVELOPMENT_POLICY: JSON.stringify({
      labRoot: plan.root,
      protectedRoots: plan.protectedRoots,
    }),
    PASEO_HOME: plan.home,
    PASEO_DEV_ROOT: plan.state,
    PASEO_DEV_MANAGED_HOME: "1",
    PASEO_LISTEN: `127.0.0.1:${plan.daemonPort}`,
    PASEO_DAEMON_ENDPOINT: `localhost:${plan.daemonPort}`,
    PASEO_DEV_DAEMON_ENDPOINT: `localhost:${plan.daemonPort}`,
    PASEO_ELECTRON_USER_DATA_DIR: plan.userData,
    EXPO_PORT: String(plan.metroPort),
    EXPO_DEV_URL: `http://localhost:${plan.metroPort}`,
    EXPO_PUBLIC_LOCAL_DAEMON: `localhost:${plan.daemonPort}`,
    EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL: "isolated-lab",
    PATH: `${path.join(plan.root, "node_modules/.bin")}${path.delimiter}${inherited.PATH ?? ""}`,
  });
  return env;
}
export function freePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Lab port ${port} in use; nothing was stopped`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".lab-config.json"), "utf8"));
  const plan = resolvePlan(root, manifest);
  assertLocalPaths(plan);
  const action = process.argv[2] ?? "check";
  if (action === "check") {
    console.log(
      JSON.stringify(
        {
          ...plan,
          note: "No runtime processes started; no live data copied. Not a security sandbox.",
        },
        null,
        2,
      ),
    );
    return;
  }
  const commands = {
    build: ["npm", ["run", "build:server"]],
    desktop: ["npm", ["run", "dev:desktop"]],
    server: ["npm", ["run", "dev:server"]],
    app: ["npm", ["run", "dev:app"]],
  };
  if (!(action in commands)) throw new Error("Use check, build, desktop, server or app");
  if (action === "desktop")
    await Promise.all([freePort(plan.daemonPort), freePort(plan.metroPort)]);
  if (action === "server") await freePort(plan.daemonPort);
  if (action === "app") await freePort(plan.metroPort);
  fs.mkdirSync(plan.state, { recursive: true });
  const [command, args] = commands[action];
  const child = spawn(command, args, {
    cwd: root,
    env: labEnv(plan, process.env),
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
