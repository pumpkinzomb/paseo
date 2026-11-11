import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stageFullRelease } from "./dev-update-full-stage.mjs";
import { INTENT_FILE, prepareReleaseIntent, inspectCandidate } from "./dev-update-discovery.mjs";
import {
  atomicJson,
  scanRelease,
  manifestDigest,
  privateDirectory,
  verifyRelease,
} from "./dev-update-store.mjs";
const exec = promisify(execFile);
async function fixture(t, mode = "full") {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "full-stage-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository"),
    releases = path.join(root, "releases"),
    cacheRoot = path.join(root, "cache");
  for (const dir of [repository, releases, cacheRoot]) await privateDirectory(dir);
  const git = async (...args) => (await exec("git", ["-C", repository, ...args])).stdout.trim();
  await git("init");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(repository, "native.txt"), "base");
  await git("add", ".");
  await git("commit", "-m", "base");
  const base = await git("rev-parse", "HEAD");
  const baseRoot = path.join(releases, "base");
  await privateDirectory(baseRoot);
  await fs.writeFile(path.join(baseRoot, "native.txt"), "base");
  const manifest = {
    schemaVersion: 1,
    id: "base",
    sourceRevision: base,
    stateCompatibility: "preserve",
    entries: await scanRelease(baseRoot),
  };
  await atomicJson(path.join(baseRoot, "release.json"), manifest);
  await fs.writeFile(path.join(repository, "native.txt"), "candidate");
  await git("add", ".");
  await git("commit", "-m", "candidate");
  const intent = await prepareReleaseIntent({ repository, baseRevision: base, mode });
  await fs.writeFile(path.join(repository, INTENT_FILE), JSON.stringify(intent));
  await git("add", ".");
  await git("commit", "-m", "intent");
  const revision = await git("rev-parse", "HEAD");
  const candidate = await inspectCandidate({
    repository,
    installedRevision: base,
    candidateRevision: revision,
  });
  const bareRepository = path.join(root, "bare-cache.git");
  await exec("git", ["clone", "--bare", "--no-hardlinks", repository, bareRepository]);
  return {
    root,
    repository: bareRepository,
    releases,
    cacheRoot,
    candidate: { ...candidate, revision },
    current: { id: "base", digest: manifestDigest(manifest), manifest, root: baseRoot },
    protectedPaths: [repository, bareRepository, releases],
    minFreeBytes: 0,
    git,
  };
}
async function fakeStage({ source, releases, id, statePreserving }) {
  assert.equal(statePreserving, true);
  assert.equal((await exec("git", ["-C", source, "status", "--porcelain"])).stdout, "");
  const plan = JSON.parse(await fs.readFile(path.join(source, ".lab-config.json"), "utf8"));
  assert.equal(plan.role, "development-lab");
  assert.equal(plan.root, source);
  assert.notEqual(plan.daemonPort, plan.metroPort);
  const root = path.join(releases, id);
  await privateDirectory(root);
  for (const name of ["native.txt", INTENT_FILE])
    await fs.copyFile(path.join(source, name), path.join(root, name));
  const sourceRevision = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const manifest = {
    schemaVersion: 1,
    id,
    sourceRevision,
    stateCompatibility: "preserve",
    entries: await scanRelease(root),
  };
  await atomicJson(path.join(root, "release.json"), manifest);
  return { id, digest: manifestDigest(manifest) };
}
test("exact full intent clones clean isolated source, builds, launches then returns sealed selection", async (t) => {
  const f = await fixture(t);
  const events = [];
  const selected = await stageFullRelease({
    ...f,
    stage: async (args) => {
      events.push("build");
      assert.notEqual(args.source, f.repository);
      return fakeStage(args);
    },
    validateLaunch: async ({ root }) => {
      events.push("launch");
      assert.equal(await fs.readFile(path.join(root, "native.txt"), "utf8"), "candidate");
    },
  });
  assert.deepEqual(events, ["build", "launch"]);
  await verifyRelease(f.releases, selected.id, selected.digest);
  await verifyRelease(f.releases, f.current.id, f.current.digest);
  const again = await stageFullRelease({
    ...f,
    stage: async () => {
      throw new Error("must reuse seal");
    },
    validateLaunch: async () => {
      events.push("revalidate");
    },
  });
  assert.deepEqual(again, selected);
  assert.equal(events.at(-1), "revalidate");
  assert.equal(await f.git("status", "--porcelain"), "");
});
test("wrong intent, disk reserve and protected overlap never call build", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const stage = async () => {
    calls++;
    throw new Error("unexpected");
  };
  await assert.rejects(stageFullRelease({ ...f, stage, availableBytes: 0 }), /disk reserve/);
  await assert.rejects(
    stageFullRelease({ ...f, stage, cacheRoot: path.join(f.repository, "cache") }),
    /overlaps/,
  );
  await assert.rejects(
    stageFullRelease({
      ...f,
      stage,
      candidate: { ...f.candidate, revision: f.current.manifest.sourceRevision },
    }),
    /exact verified/,
  );
  assert.equal(calls, 0);
});
test("launch failure returns no selection and leaves sealed diagnostic artifacts", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    stageFullRelease({
      ...f,
      stage: fakeStage,
      validateLaunch: async () => {
        throw new Error("launch failed");
      },
    }),
    /launch failed/,
  );
  assert.equal((await fs.readdir(f.releases)).length, 2);
  await verifyRelease(f.releases, f.current.id, f.current.digest);
});
test("launch mutation of sealed native bytes fails final verification", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    stageFullRelease({
      ...f,
      stage: fakeStage,
      validateLaunch: async ({ root }) => fs.writeFile(path.join(root, "native.txt"), "mutated"),
    }),
    /contents changed/,
  );
  await verifyRelease(f.releases, f.current.id, f.current.digest);
});
