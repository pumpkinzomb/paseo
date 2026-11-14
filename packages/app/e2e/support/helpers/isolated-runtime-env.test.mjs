import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { isolatedRuntimeEnv } from "./isolated-runtime-env.mjs";

const root = path.resolve("test-owned-runtime");
const hostile = {
  HOME: "/live/user",
  USERPROFILE: "/live/user",
  XDG_CONFIG_HOME: "/live/config",
  XDG_DATA_HOME: "/live/data",
  XDG_CACHE_HOME: "/live/cache",
  XDG_STATE_HOME: "/live/state",
  XDG_RUNTIME_DIR: "/live/runtime",
  TMPDIR: "/live/tmp",
  CODEX_HOME: "/live/codex",
  CLAUDE_CONFIG_DIR: "/live/claude",
  PI_CODING_AGENT_DIR: "/live/pi",
  PASEO_HOME: "/live/paseo",
  PASEO_INSTALLED_UPDATE_CONTROL: "1",
  PASEO_DEV_UPDATE_DAEMON_CONTROL: "/live/control",
  PASEO_DEV_UPDATE_CONTROL_DIR: "/live/controller",
  PASEO_MANAGED_DEPENDENCY_REGISTRY: "/live/registry",
  PASEO_WORKTREE_SETUP_HELPER: "/live/helper",
  PASEO_SELF_DEVELOPMENT_POLICY: "live-authority",
  NODE_OPTIONS: "--import live-hook",
  NODE_PATH: "/live/modules",
  PATH: "/approved/tools",
  LANG: "en_US.UTF-8",
};
test("hostile installed runtime environment cannot activate or redirect test controllers", () => {
  const before = structuredClone(hostile);
  const env = isolatedRuntimeEnv(hostile, root);
  assert.equal(env.PASEO_INSTALLED_UPDATE_CONTROL, "0");
  assert.equal(env.PASEO_HOME, root);
  for (const key of Object.keys(hostile).filter(
    (name) =>
      name.startsWith("PASEO_") &&
      name !== "PASEO_INSTALLED_UPDATE_CONTROL" &&
      name !== "PASEO_HOME",
  ))
    assert.equal(env[key], undefined, key);
  assert.equal(JSON.stringify(env).includes("/live/"), false);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.PATH, hostile.PATH);
  assert.deepEqual(hostile, before);
});
test("all user, XDG and temporary roots stay under the individual test root", () => {
  const env = isolatedRuntimeEnv(hostile, root);
  for (const key of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    const relative = path.relative(root, env[key]);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), key);
  }
  assert.notEqual(isolatedRuntimeEnv(hostile, path.resolve("other-test-runtime")).HOME, env.HOME);
});
test("explicit test overrides cannot re-enable inherited installed or maintenance authority", () => {
  const env = isolatedRuntimeEnv(hostile, root, {
    ...hostile,
    PASEO_TEST_FIXTURE: "explicit",
    HOME: "/live/override",
  });
  assert.equal(env.PASEO_INSTALLED_UPDATE_CONTROL, "0");
  assert.equal(env.PASEO_HOME, root);
  for (const key of [
    "PASEO_DEV_UPDATE_DAEMON_CONTROL",
    "PASEO_DEV_UPDATE_CONTROL_DIR",
    "PASEO_MANAGED_DEPENDENCY_REGISTRY",
    "PASEO_WORKTREE_SETUP_HELPER",
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.HOME, path.join(root, "user-home"));
  assert.equal(env.PASEO_TEST_FIXTURE, "explicit");
  assert.equal(JSON.stringify(env).includes("/live/"), false);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CODEX_HOME, undefined);
});
test("rejects missing or filesystem-wide roots before any process can launch", () => {
  assert.throws(() => isolatedRuntimeEnv(hostile, "relative"), /test-owned/);
  assert.throws(() => isolatedRuntimeEnv(hostile, path.parse(root).root), /test-owned/);
});

test("prepares private canonical runtime directories without activating any controller", async (t) => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { prepareIsolatedRuntimeEnv } = await import("./isolated-runtime-env.mjs");
  const owned = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "isolated-env-"));
  t.after(() => fs.rm(owned, { recursive: true, force: true }));
  const env = await prepareIsolatedRuntimeEnv(hostile, owned);
  assert.equal(env.PASEO_INSTALLED_UPDATE_CONTROL, "0");
  assert.equal(env.PASEO_DEV_UPDATE_DAEMON_CONTROL, undefined);
  for (const key of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
  ]) {
    assert.equal(await fs.realpath(env[key]), env[key]);
    assert.equal((await fs.lstat(env[key])).mode & 0o777, 0o700);
  }
  assert.deepEqual((await fs.readdir(owned)).sort(), ["tmp", "user-home", "xdg-runtime"]);
});
test("does not follow a fixture home symlink outside its owned root", async (t) => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { prepareIsolatedRuntimeEnv } = await import("./isolated-runtime-env.mjs");
  const base = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "isolated-env-links-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const owned = path.join(base, "owned"),
    outside = path.join(base, "outside");
  await fs.mkdir(owned, { mode: 0o700 });
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, path.join(owned, "user-home"));
  await assert.rejects(prepareIsolatedRuntimeEnv(hostile, owned), /Unsafe test runtime directory/);
  assert.deepEqual(await fs.readdir(outside), []);
});
