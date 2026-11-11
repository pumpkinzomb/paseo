import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { prepareLabDependencies, resolvePlan, assertLocalPaths, labEnv } from "./isolated-lab.mjs";
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-boundary-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "lab"),
    live = path.join(base, "live");
  fs.mkdirSync(root);
  fs.mkdirSync(live);
  return {
    root,
    live,
    m: {
      role: "development-lab",
      root,
      protectedRoots: [live],
      daemonPort: 6778,
      metroPort: 8092,
    },
  };
}
test("lab paths and ports separate from live", (t) => {
  const f = fixture(t),
    p = resolvePlan(f.root, f.m);
  assert.equal(p.home, path.join(fs.realpathSync(f.root), ".lab/paseo-home"));
  assertLocalPaths(p);
});
test("reject live root and reserved ports", (t) => {
  const f = fixture(t);
  assert.throws(() => resolvePlan(f.root, { ...f.m, protectedRoots: [f.root] }), /overlaps/);
  for (const port of [6768, 8084])
    assert.throws(() => resolvePlan(f.root, { ...f.m, daemonPort: port }), /Unsafe/);
});
test("reject outputs and workspace dependencies linked to runtime", (t) => {
  const f = fixture(t),
    p = resolvePlan(f.root, f.m);
  fs.symlinkSync(f.live, path.join(f.root, "node_modules"));
  assert.throws(() => assertLocalPaths(p), /escapes/);
});
test("strip inherited live endpoints and data seeding", (t) => {
  const f = fixture(t),
    p = resolvePlan(f.root, f.m);
  const e = labEnv(p, {
    PATH: "/bin",
    PASEO_HOME: f.live,
    PASEO_DEV_SEED_HOME: f.live,
    PASEO_DEV_RESET_HOME: "1",
    PASEO_LISTEN: "127.0.0.1:6768",
    EXPO_DEV_URL: "http://localhost:8084",
    NODE_OPTIONS: "--import /unwanted",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.equal(e.PASEO_HOME, p.home);
  assert.equal(e.PASEO_LISTEN, "127.0.0.1:6778");
  assert.equal(e.EXPO_DEV_URL, "http://localhost:8092");
  assert.equal(e.PASEO_DEV_SEED_HOME, undefined);
  assert.equal(e.PASEO_DEV_RESET_HOME, undefined);
  assert.equal(e.NODE_OPTIONS, undefined);
});
test("reject changed lab identity", (t) => {
  const f = fixture(t);
  assert.throws(() => resolvePlan(f.root, { ...f.m, root: f.live }), /identity/);
});

test("reject live state symlink nested under lab", (t) => {
  const f = fixture(t),
    p = resolvePlan(f.root, f.m);
  fs.mkdirSync(path.join(f.root, ".lab"));
  fs.symlinkSync(f.live, path.join(f.root, ".lab/paseo-home"));
  assert.throws(() => assertLocalPaths(p), /escapes/);
});

function dependencyFixture(t) {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, ".lab-config.json"), JSON.stringify(f.m));
  execFileSync("git", ["init", "--quiet", f.root]);
  return { ...f, releases: f.live, donor: { id: "sealed", digest: "a".repeat(64) } };
}
test("lab preparation uses explicit verified reuse only, including external target", async (t) => {
  const f = dependencyFixture(t);
  fs.writeFileSync(path.join(f.root, "CLAUDE.md"), "lab rules");
  fs.symlinkSync("CLAUDE.md", path.join(f.root, "AGENTS.md"));
  let calls = 0;
  const result = await prepareLabDependencies(f, {
    prepare: async (options) => {
      calls++;
      assert.equal(options.source, fs.realpathSync(f.root));
      assert.equal(options.allowInstall, false);
      assert.equal(options.minFreeBytes, 8 * 1024 ** 3);
      assert.deepEqual(options.donor, f.donor);
      return { mode: "reuse", donor: f.donor };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.mode, "reuse");
  assert.equal(fs.existsSync(path.join(f.root, ".dependency-preparation.lock")), false);
});
test("lab preparation refuses existing dependencies without changing them", async (t) => {
  const f = dependencyFixture(t);
  fs.mkdirSync(path.join(f.root, "packages/app/node_modules"), { recursive: true });
  const payload = path.join(f.root, "packages/app/node_modules/keep");
  fs.writeFileSync(payload, "keep");
  await assert.rejects(
    prepareLabDependencies(f, { prepare: async () => assert.fail("must not clone") }),
    /empty real/,
  );
  assert.equal(fs.readFileSync(payload, "utf8"), "keep");
});
test("lab preparation rejects missing donor, overlap, untracked inputs and concurrent owner", async (t) => {
  const f = dependencyFixture(t);
  const stub = { prepare: async () => assert.fail("must not clone") };
  await assert.rejects(prepareLabDependencies({ ...f, donor: null }, stub), /donor/);
  await assert.rejects(prepareLabDependencies({ ...f, releases: f.root }, stub), /overlaps/);
  fs.writeFileSync(path.join(f.root, ".gitignore"), "package.json\n");
  fs.writeFileSync(path.join(f.root, "package.json"), "{}");
  await assert.rejects(prepareLabDependencies(f, stub), /Untracked/);
  fs.unlinkSync(path.join(f.root, "package.json"));
  const lock = path.join(f.root, ".dependency-preparation.lock");
  fs.writeFileSync(lock, "owner");
  await assert.rejects(prepareLabDependencies(f, stub), /EEXIST/);
  assert.equal(fs.readFileSync(lock, "utf8"), "owner");
});
test("failed lab reuse never installs or retries and releases its lock", async (t) => {
  const f = dependencyFixture(t);
  let calls = 0;
  await assert.rejects(
    prepareLabDependencies(f, {
      prepare: async () => {
        calls++;
        throw new Error("clone unavailable");
      },
    }),
    /clone unavailable/,
  );
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(f.root, ".dependency-preparation.lock")), false);
});

test("lab preparation retains a replacement lock owned by someone else", async (t) => {
  const f = dependencyFixture(t);
  const lock = path.join(f.root, ".dependency-preparation.lock");
  await prepareLabDependencies(f, {
    prepare: async () => {
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, "replacement owner");
      return { mode: "reuse", donor: f.donor };
    },
  });
  assert.equal(fs.readFileSync(lock, "utf8"), "replacement owner");
});
