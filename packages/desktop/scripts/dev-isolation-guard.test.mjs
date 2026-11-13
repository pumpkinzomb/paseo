import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveDevRuntime } from "./dev-runtime-config.mjs";
import { assertIsolatedDevEnvironment } from "./dev-isolation-guard.mjs";
import { labEnv, resolvePlan } from "../../../scripts/isolated-lab.mjs";
const exec = promisify(execFile);
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paseo-dev-guard-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "lab");
  const live = path.join(base, "live");
  await fs.mkdir(root);
  await fs.mkdir(live);
  const manifest = {
    role: "development-lab",
    root,
    protectedRoots: [live],
    daemonPort: 17951,
    metroPort: 18117,
  };
  await fs.writeFile(path.join(root, ".lab-config.json"), JSON.stringify(manifest));
  const env = labEnv(resolvePlan(root, manifest), { PATH: process.env.PATH });
  return { base, root, live, env };
}
test("accepts explicit lab values without creating any state", async (t) => {
  const x = await fixture(t);
  assert.equal(assertIsolatedDevEnvironment(x.root, x.env).home, x.env.PASEO_HOME);
  assert.equal(resolveDevRuntime(x.env).userDataDir, x.env.PASEO_ELECTRON_USER_DATA_DIR);
  assert.deepEqual(await fs.readdir(x.root), [".lab-config.json"]);
});
test("rejects missing and inherited runtime identity or ports", async (t) => {
  const x = await fixture(t);
  for (const key of [
    "PASEO_HOME",
    "PASEO_DEV_ROOT",
    "PASEO_DEV_MANAGED_HOME",
    "PASEO_LISTEN",
    "PASEO_DAEMON_ENDPOINT",
    "PASEO_DEV_DAEMON_ENDPOINT",
    "PASEO_ELECTRON_USER_DATA_DIR",
    "EXPO_PORT",
    "EXPO_DEV_URL",
  ]) {
    const missing = { ...x.env };
    delete missing[key];
    assert.throws(() => assertIsolatedDevEnvironment(x.root, missing), new RegExp(key));
    assert.throws(
      () => assertIsolatedDevEnvironment(x.root, { ...x.env, [key]: "runtime-inherited" }),
      new RegExp(key),
    );
  }
});
test("rejects seed/reset and execution/profile overrides", async (t) => {
  const x = await fixture(t);
  for (const key of [
    "PASEO_DEV_SEED_HOME",
    "PASEO_DEV_RESET_HOME",
    "PASEO_ELECTRON_FLAGS",
    "PASEO_DESKTOP_PROFILE",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
  ])
    assert.throws(
      () => assertIsolatedDevEnvironment(x.root, { ...x.env, [key]: "1" }),
      new RegExp(key),
    );
});
test("rejects lab state symlink to live state", async (t) => {
  const x = await fixture(t);
  await fs.symlink(x.live, path.join(x.root, ".lab"));
  assert.throws(() => assertIsolatedDevEnvironment(x.root, x.env), /escapes lab/);
});
test("dev.sh guard fails before any inherited home can be written", async (t) => {
  const x = await fixture(t);
  const sentinel = path.join(x.live, "config.json");
  await fs.writeFile(sentinel, "unchanged");
  const devSh = fileURLToPath(new URL("./dev.sh", import.meta.url));
  await assert.rejects(
    exec("bash", [devSh], {
      env: {
        PATH: process.env.PATH,
        HOME: os.homedir(),
        PASEO_ISOLATED_DEV: "1",
        PASEO_HOME: x.live,
        PASEO_DEV_MANAGED_HOME: "1",
        PASEO_DEV_RESET_HOME: "1",
        PASEO_DEV_SEED_HOME: x.live,
      },
    }),
    /Isolated dev requires/,
  );
  assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged");
  assert.deepEqual(await fs.readdir(x.live), ["config.json"]);
});
