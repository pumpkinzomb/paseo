import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanRelease, hash, manifestDigest } from "./dev-update-store.mjs";
import {
  prepareDependencies,
  cloneDependencyEntries,
  verifyDependencyEntries,
  isDependencyInput,
} from "./dev-update-dependencies.mjs";
const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "dependency-reuse-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, "scratch"),
    source = path.join(managedRoot, "source"),
    releases = path.join(root, "releases"),
    donorRoot = path.join(releases, "base");
  await fs.mkdir(source, { recursive: true, mode: 0o700 });
  await fs.mkdir(donorRoot, { recursive: true, mode: 0o700 });
  for (const [file, data] of Object.entries({
    "package.json": JSON.stringify({
      scripts: {
        postinstall: "node scripts/postinstall-patches.mjs",
        prepare: "lefthook install --force",
      },
    }),
    "package-lock.json": "{}",
    "scripts/postinstall-patches.mjs": "// reviewed patch hook\n",
    "packages/app/package.json": "{}",
    "packages/app/package-lock.json": "{}",
    "patches/example.patch": "patch\n",
    ".npmrc": "fund=false\n",
    "lefthook.yml": "pre-commit: {}\n",
  })) {
    for (const dir of [source, donorRoot]) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), data);
    }
  }
  for (const args of [
    ["init"],
    ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.invalid"],
    ["add", "."],
    ["commit", "-m", "base"],
  ])
    await exec("git", args, { cwd: source });
  const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  await fs.mkdir(path.join(donorRoot, "node_modules/electron/dist"), { recursive: true });
  await fs.writeFile(
    path.join(donorRoot, "node_modules/electron/dist/electron"),
    "fixture executable",
    { mode: 0o755 },
  );
  await fs.mkdir(path.join(donorRoot, "packages/app/node_modules/pkg"), { recursive: true });
  await fs.writeFile(
    path.join(donorRoot, "packages/app/node_modules/pkg/index.js"),
    "fixture nested",
  );
  await fs.mkdir(path.join(donorRoot, "node_modules/.vite"), { recursive: true });
  await fs.writeFile(path.join(donorRoot, "node_modules/.vite/results.json"), "cache");
  await fs.mkdir(path.join(donorRoot, "packages/app/dist"));
  await fs.writeFile(path.join(donorRoot, "packages/app/dist/package.json"), "generated");
  await fs.symlink("../packages/app", path.join(donorRoot, "node_modules/app"));
  const manifest = {
    schemaVersion: 1,
    id: "base",
    stateCompatibility: "preserve",
    sourceRevision: revision,
    entries: await scanRelease(donorRoot),
  };
  const donor = { id: "base", digest: manifestDigest(manifest) };
  await fs.writeFile(path.join(donorRoot, "release.json"), JSON.stringify(manifest));
  return {
    root,
    managedRoot,
    releases,
    source,
    donorRoot,
    manifest,
    options: {
      source,
      releases,
      donor,
      minFreeBytes: 0,
      verify: async (releaseDirectory, id, digest) => {
        assert.equal(releaseDirectory, path.join(root, "releases"));
        assert.equal(id, donor.id);
        assert.equal(digest, donor.digest);
        return { root: donorRoot, manifest };
      },
    },
  };
}
test("exact install inputs reuse only dependency entries, including nested Electron payload", async (t) => {
  const f = await fixture(t);
  let plan;
  const result = await prepareDependencies({
    ...f.options,
    clone: async (p) => {
      plan = p;
    },
  });
  assert.equal(result.mode, "reuse");
  assert.ok(plan.entries["node_modules/electron/dist/electron"]);
  assert.ok(plan.entries["packages/app/node_modules/pkg/index.js"]);
  assert.ok(plan.entries["node_modules/app"]);
  assert.equal(plan.entries["node_modules/.vite/results.json"], undefined);
  assert.equal(plan.entries["packages/app/dist/package.json"], undefined);
});
test("changed patch/helper/config/nested lock requires explicit clean install", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "scripts/postinstall-patches.mjs",
    "patches/example.patch",
    ".npmrc",
    "lefthook.yml",
    "packages/app/package-lock.json",
  ]) {
    const file = path.join(f.source, name),
      before = await fs.readFile(file);
    await fs.appendFile(file, "\nchanged\n");
    await assert.rejects(prepareDependencies(f.options), /inputs changed/);
    assert.equal((await prepareDependencies({ ...f.options, allowInstall: true })).mode, "install");
    await fs.writeFile(file, before);
  }
});
test("new package manifests and unknown lifecycle hooks cannot silently reuse", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.source, "packages/app/package.json"),
    JSON.stringify({ scripts: { postinstall: "node custom.js" } }),
  );
  await assert.rejects(prepareDependencies(f.options), /Unreviewed/);
  assert.equal((await prepareDependencies({ ...f.options, allowInstall: true })).mode, "install");
});
test("missing donor needs explicit installation; clone failure never falls back", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareDependencies({ ...f.options, donor: undefined }), /explicitly/);
  assert.equal(
    (await prepareDependencies({ ...f.options, donor: undefined, allowInstall: true })).mode,
    "install",
  );
  await assert.rejects(
    prepareDependencies({
      ...f.options,
      allowInstall: true,
      clone: async () => {
        throw Error("clone unavailable");
      },
    }),
    /clone unavailable/,
  );
});
test("strict CoW clone is independent, preserves symlinks/mode and detects later corruption", async (t) => {
  const f = await fixture(t);
  const result = await prepareDependencies(f.options);
  assert.equal(result.mode, "reuse");
  await verifyDependencyEntries(f.source, result.entries, f.donorRoot);
  const target = path.join(f.source, "node_modules/electron/dist/electron");
  await fs.writeFile(target, "changed");
  assert.equal(
    await fs.readFile(path.join(f.donorRoot, "node_modules/electron/dist/electron"), "utf8"),
    "fixture executable",
  );
  await assert.rejects(verifyDependencyEntries(f.source, result.entries), /payload changed/);
});
test("clone refuses collisions, path traversal, aliases and insufficient reserve", async (t) => {
  const f = await fixture(t),
    entry = {
      "node_modules/electron/dist/electron":
        f.manifest.entries["node_modules/electron/dist/electron"],
    };
  await assert.rejects(
    cloneDependencyEntries({
      source: f.donorRoot,
      destination: f.source,
      entries: entry,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    /reserve/,
  );
  await fs.symlink(f.donorRoot, path.join(f.source, "node_modules"));
  await assert.rejects(
    cloneDependencyEntries({
      source: f.donorRoot,
      destination: f.source,
      entries: entry,
      minFreeBytes: 0,
    }),
    /alias/,
  );
  await assert.rejects(
    cloneDependencyEntries({
      source: f.source,
      destination: f.source,
      entries: entry,
      minFreeBytes: 0,
    }),
    /overlap/,
  );
  await assert.rejects(
    cloneDependencyEntries({
      source: f.donorRoot,
      destination: f.source,
      entries: { "node_modules/../../escape": { sha256: hash("x"), executable: false } },
      minFreeBytes: 0,
    }),
    /Unsafe/,
  );
});
test("input classification includes install configuration, excludes payload manifests", () => {
  for (const name of [
    "package.json",
    "packages/a/npm-shrinkwrap.json",
    ".yarnrc.yml",
    "patches/a.patch",
    "packages/a/patches/a.patch",
    "lefthook.yml",
    "scripts/postinstall-patches.mjs",
  ])
    assert.equal(isDependencyInput(name), true, name);
  assert.equal(isDependencyInput("node_modules/pkg/package.json"), false);
});

test("missing donor history fails closed even when installation was allowed", async (t) => {
  const f = await fixture(t);
  f.manifest.sourceRevision = "0".repeat(40);
  await assert.rejects(
    prepareDependencies({ ...f.options, allowInstall: true }),
    /donor commit is unavailable/,
  );
});

test("real pre-build failure hook prunes only its verified clone, retaining source and receipt", async (t) => {
  const f = await fixture(t);
  const { prepareStageDependencies } = await import("./dev-update.mjs");
  const { registerDependencyScratch } = await import("./dev-update-cleanup.mjs");
  let failure;
  try {
    await prepareStageDependencies(
      {
        staging: f.source,
        releases: f.releases,
        dependencyDonor: f.options.donor,
        installDependencies: false,
        minFreeBytes: 0,
        managedRoot: f.managedRoot,
        protectedPaths: [f.donorRoot],
      },
      {
        register: (options) => registerDependencyScratch({ ...options, minFileBytes: 0 }),
        prepare: (options) =>
          prepareDependencies({
            ...options,
            clone: async (plan) => {
              await cloneDependencyEntries(plan);
              throw Error("forced pre-build failure");
            },
          }),
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.match(failure?.message ?? "", /forced pre-build failure/);
  assert.equal(failure.dependencyCleanupError, undefined);
  assert.equal(failure.dependencyCleanup.result.state, "dependencies-pruned");
  await assert.rejects(fs.access(path.join(f.source, "node_modules/electron/dist/electron")), {
    code: "ENOENT",
  });
  await fs.access(path.join(f.source, "package.json"));
  await fs.access(path.join(f.source, ".git"));
  await fs.access(path.join(f.source, ".dependencies-pruned.json"));
  assert.equal(
    await fs.readFile(path.join(f.donorRoot, "node_modules/electron/dist/electron"), "utf8"),
    "fixture executable",
  );
});

test("native clone input/spawn errors do not permit cleanup before child close", async () => {
  const { EventEmitter } = await import("node:events");
  const { runNativeClone } = await import("./dev-update-dependencies.mjs");
  for (const source of ["stdin", "process"]) {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin.end = () => {};
    let settled = false;
    const result = runNativeClone({}, { spawnProcess: () => child }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    (source === "stdin" ? child.stdin : child).emit("error", Error("early error"));
    await Promise.resolve();
    assert.equal(settled, false);
    child.emit("close", 1);
    assert.match((await result).message, /early error/);
  }
});
