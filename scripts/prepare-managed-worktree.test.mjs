import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { prepareManagedWorktree } from "./prepare-managed-worktree.mjs";
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "managed-worktree-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source"),
    root = path.join(base, "child"),
    live = path.join(base, "live");
  await fs.mkdir(source);
  await fs.mkdir(live);
  const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
  git("init", "-q");
  await fs.writeFile(path.join(source, "package.json"), '{"name":"fixture"}');
  await fs.writeFile(path.join(source, "package-lock.json"), "{}");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  git("worktree", "add", "-q", "--detach", root);
  const context = {
    releases: live,
    maintenanceRegistry: path.join(live, "managed-worktrees"),
    donor: { id: "release", digest: "a".repeat(64) },
    protectedRoots: [live],
    sourceRoot: source,
  };
  const env = {
    PASEO_WORKTREE_PATH: root,
    PASEO_WORKTREE_DEPENDENCY_CONTEXT: JSON.stringify(context),
  };
  return { source, root, live, context, env };
}
test("missing managed context cannot install", async () => {
  await assert.rejects(prepareManagedWorktree({}), /context is required/);
});
test("separate managed worktree reuses dependencies without installing or seeding state", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await prepareManagedWorktree(f.env, {
    prepare: async (options) => {
      calls++;
      assert.equal(options.allowInstall, false);
      assert.equal(options.minFreeBytes, 8 * 1024 ** 3);
      assert.equal(options.source, f.root);
      assert.deepEqual(options.donor, f.context.donor);
      return { mode: "reuse", donor: options.donor, entries: {} };
    },
  });
  assert.equal(result.mode, "reuse");
  assert.equal(calls, 1);
  assert.equal((await fs.readdir(f.context.maintenanceRegistry)).length, 1);
  assert.equal((await prepareManagedWorktree(f.env)).mode, "already-prepared");
  await assert.rejects(fs.stat(path.join(f.root, ".dev")), { code: "ENOENT" });
});
test("source checkout, alias, protected overlap, and existing dependency installs are rejected", async (t) => {
  const f = await fixture(t),
    stub = { prepare: async () => assert.fail("must not prepare") };
  await assert.rejects(
    prepareManagedWorktree({ ...f.env, PASEO_WORKTREE_PATH: f.source }, stub),
    /separate worktree/,
  );
  const alias = path.join(path.dirname(f.root), "alias");
  await fs.symlink(f.root, alias);
  await assert.rejects(
    prepareManagedWorktree({ ...f.env, PASEO_WORKTREE_PATH: alias }, stub),
    /alias/,
  );
  await assert.rejects(
    prepareManagedWorktree(
      {
        ...f.env,
        PASEO_WORKTREE_DEPENDENCY_CONTEXT: JSON.stringify({
          ...f.context,
          protectedRoots: [f.root],
        }),
      },
      stub,
    ),
    /overlaps/,
  );
  await fs.mkdir(path.join(f.root, "node_modules"));
  await fs.writeFile(path.join(f.root, "node_modules", "keep"), "keep");
  await assert.rejects(prepareManagedWorktree(f.env, stub), /Existing dependencies/);
  assert.equal(await fs.readFile(path.join(f.root, "node_modules", "keep"), "utf8"), "keep");
});
test("setup failure releases lock without falling back to installation", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(
    prepareManagedWorktree(f.env, {
      prepare: async () => {
        calls++;
        throw new Error("CoW unavailable");
      },
    }),
    /CoW unavailable/,
  );
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(path.join(f.root, ".managed-dependency-setup.lock")), {
    code: "ENOENT",
  });
});
test("repository worktree setup has no install or state/cache copying commands", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../paseo.json", import.meta.url), "utf8"));
  assert.equal(config.worktree.setup[0], "node ./scripts/prepare-managed-worktree.mjs");
  assert.equal(
    config.worktree.setup.some((command) => /npm (ci|install)|seed-/.test(command)),
    false,
  );
});

test("runtime supplies the current sealed donor and trusted setup helper", async () => {
  const { managedWorktreeEnvironment } = await import("./dev-update-runtime.mjs");
  const { manifestDigest } = await import("./dev-update-store.mjs");
  const config = {
    releases: "/releases",
    home: "/home",
    userData: "/data",
    selfDevelopmentPolicy: { labRoot: "/lab" },
  };
  const manifest = { id: "current", sourceRevision: "abc" };
  const env = managedWorktreeEnvironment(config, "/releases/current", "/control", manifest);
  const context = JSON.parse(env.PASEO_WORKTREE_DEPENDENCY_CONTEXT);
  assert.deepEqual(context.donor, { id: "current", digest: manifestDigest(manifest) });
  assert.equal(context.sourceRoot, "/lab");
  assert.deepEqual(context.protectedRoots, ["/releases/current", "/home", "/data", "/control"]);
  assert.equal(
    env.PASEO_WORKTREE_SETUP_HELPER,
    "/releases/current/scripts/prepare-managed-worktree.mjs",
  );
  assert.deepEqual(managedWorktreeEnvironment({}, "/release", "/control", manifest), {});
});
