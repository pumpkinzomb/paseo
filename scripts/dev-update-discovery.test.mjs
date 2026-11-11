import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  INTENT_FILE,
  prepareReleaseIntent,
  inspectCandidate,
  fetchCandidate,
  stageRendererRelease,
  createDiscovery,
  validateDiscoveryConfig,
  queueDiscoveredRelease,
} from "./dev-update-discovery.mjs";
import {
  atomicJson,
  scanRelease,
  manifestDigest,
  privateDirectory,
  verifyRelease,
  isRendererOnly,
} from "./dev-update-store.mjs";
const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "discovery-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "source"),
    releases = path.join(root, "releases"),
    cacheRoot = path.join(root, "cache"),
    control = path.join(root, "control");
  for (const dir of [repository, releases, cacheRoot, control]) await privateDirectory(dir);
  const git = async (...args) => (await exec("git", ["-C", repository, ...args])).stdout.trim();
  await git("init");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  async function write(name, text) {
    await fs.mkdir(path.dirname(path.join(repository, name)), { recursive: true });
    await fs.writeFile(path.join(repository, name), text);
  }
  async function commit() {
    await git("add", ".");
    await git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  }
  await write("packages/app/src/view.ts", "export const view = 1;\n");
  await write("packages/server/dist/index.js", "native bytes");
  const base = await commit();
  async function candidate(mode = "renderer") {
    const intent = await prepareReleaseIntent({ repository, baseRevision: base, mode });
    await write(INTENT_FILE, JSON.stringify(intent));
    const head = await commit();
    return inspectCandidate({ repository, installedRevision: base, candidateRevision: head });
  }
  const baseRoot = path.join(releases, "base");
  await fs.mkdir(baseRoot);
  await fs.cp(path.join(repository, "packages"), path.join(baseRoot, "packages"), {
    recursive: true,
  });
  const manifest = {
    schemaVersion: 1,
    id: "base",
    sourceRevision: base,
    stateCompatibility: "preserve",
    entries: await scanRelease(baseRoot),
  };
  await atomicJson(path.join(baseRoot, "release.json"), manifest);
  const current = { id: "base", root: baseRoot, manifest, digest: manifestDigest(manifest) };
  const config = {
    enabled: true,
    remoteUrl: "https://github.com/pumpkinzomb/paseo.git",
    ref: "refs/heads/main",
    releases,
    cacheRoot,
    protectedPaths: [repository, releases, control],
  };
  return {
    root,
    repository,
    releases,
    cacheRoot,
    control,
    git,
    write,
    commit,
    candidate,
    base,
    current,
    config,
  };
}
test("real Git intent binds source/base; behind and divergence never stage", async (t) => {
  const f = await fixture(t);
  await f.write("packages/app/src/view.ts", "new");
  const changed = await f.commit();
  assert.equal(
    (
      await inspectCandidate({
        repository: f.repository,
        installedRevision: f.base,
        candidateRevision: changed,
      })
    ).state,
    "rejected",
  );
  const c = await f.candidate();
  assert.equal(c.state, "eligible");
  assert.equal(
    (
      await inspectCandidate({
        repository: f.repository,
        installedRevision: c.revision,
        candidateRevision: f.base,
      })
    ).state,
    "behind",
  );
  await f.write("packages/app/src/view.ts", "tampered");
  const stale = await f.commit();
  assert.equal(
    (
      await inspectCandidate({
        repository: f.repository,
        installedRevision: f.base,
        candidateRevision: stale,
      })
    ).reason,
    "intent-does-not-bind-this-update",
  );
  await f.git("checkout", "-b", "divergence", f.base);
  await f.write("docs/note.md", "divergence");
  const divergent = await f.commit();
  assert.equal(
    (
      await inspectCandidate({
        repository: f.repository,
        installedRevision: c.revision,
        candidateRevision: divergent,
      })
    ).reason,
    "diverged",
  );
});
test("renderer declaration rejects native change and allows explicit full", async (t) => {
  const f = await fixture(t);
  await f.write("packages/server/dist/index.js", "changed");
  await f.commit();
  assert.equal((await f.candidate()).state, "rejected");
  assert.equal((await f.candidate("full")).state, "eligible");
});
test("renderer independent overlay retains native bytes; checks and launch required, reusable", async (t) => {
  const f = await fixture(t);
  await f.write("packages/app/src/view.ts", "new");
  await f.write("docs/new.md", "metadata");
  await f.commit();
  const candidate = await f.candidate();
  let checks = 0,
    launches = 0;
  const args = {
    ...f,
    candidate,
    minFreeBytes: 0,
    runChecks: async () => {
      checks++;
    },
    validateLaunch: async () => {
      launches++;
    },
  };
  await assert.rejects(stageRendererRelease({ ...args, availableBytes: 0 }), /disk reserve/);
  await assert.rejects(
    stageRendererRelease({ ...args, validateLaunch: undefined }),
    /launch validation/,
  );
  const staged = await stageRendererRelease(args);
  const verified = await verifyRelease(f.releases, staged.id, staged.digest);
  assert.equal(isRendererOnly(f.current.manifest, verified.manifest), true);
  assert.equal(
    await fs.readFile(path.join(f.current.root, "packages/app/src/view.ts"), "utf8"),
    "export const view = 1;\n",
  );
  assert.equal(
    await fs.readFile(path.join(verified.root, "packages/app/src/view.ts"), "utf8"),
    "new",
  );
  await assert.rejects(fs.access(path.join(verified.root, "docs/new.md")));
  assert.deepEqual(await stageRendererRelease(args), staged);
  assert.equal(checks, 1);
  assert.equal(launches, 1);
});
test("failed validation never publishes a candidate or mutates base", async (t) => {
  const f = await fixture(t);
  await f.write("packages/app/src/view.ts", "new");
  await f.commit();
  const candidate = await f.candidate();
  await assert.rejects(
    stageRendererRelease({
      ...f,
      candidate,
      minFreeBytes: 0,
      runChecks: async () => {
        throw new Error("check failed");
      },
      validateLaunch: async () => {},
    }),
    /check failed/,
  );
  assert.deepEqual(await fs.readdir(f.releases), ["base"]);
  await verifyRelease(f.releases, f.current.id, f.current.digest);
});
test("single-flight, stop prevents queue; persisted stage resumes without rebuild", async (t) => {
  const f = await fixture(t);
  await f.write("packages/app/src/view.ts", "new");
  await f.commit();
  const candidate = await f.candidate();
  let stages = 0,
    queued = 0,
    unblock;
  const barrier = new Promise((resolve) => {
    unblock = resolve;
  });
  const options = {
    config: f.config,
    control: f.control,
    readCurrent: async () => f.current,
    fetch: async () => ({ repository: f.repository, candidateRevision: candidate.revision }),
    queue: async () => {
      queued++;
    },
    stageRenderer: async (args) => {
      stages++;
      await barrier;
      return stageRendererRelease({
        ...args,
        minFreeBytes: 0,
        runChecks: async () => {},
        validateLaunch: async () => {},
      });
    },
  };
  const d = createDiscovery(options);
  const a = d.pollOnce();
  assert.equal(d.pollOnce(), a);
  const stop = d.stop();
  unblock();
  await a;
  await stop;
  assert.equal(queued, 0);
  assert.equal(stages, 1);
  const resumed = createDiscovery(options);
  assert.equal((await resumed.pollOnce()).state, "queued");
  assert.equal(stages, 1);
  assert.equal(queued, 1);
});
test("cache is pinned; protected source overlap rejected", async (t) => {
  const f = await fixture(t);
  await validateDiscoveryConfig(f.config);
  await assert.rejects(
    validateDiscoveryConfig({ ...f.config, remoteUrl: "https://github.com/other/fork.git" }),
    /retarget/,
  );
  await assert.rejects(
    validateDiscoveryConfig({ ...f.config, cacheRoot: path.join(f.repository, "cache") }),
    /overlaps/,
  );
});

test("wrong base and symlink renderer content fail compatibility declaration", async (t) => {
  const f = await fixture(t);
  await f.write("packages/app/src/view.ts", "new");
  await f.commit();
  const c = await f.candidate();
  await f.write(INTENT_FILE, JSON.stringify({ ...c.intent, baseRevision: "0".repeat(40) }));
  const wrong = await f.commit();
  assert.equal(
    (
      await inspectCandidate({
        repository: f.repository,
        installedRevision: f.base,
        candidateRevision: wrong,
      })
    ).state,
    "rejected",
  );
  await fs.symlink("view.ts", path.join(f.repository, "packages/app/src/link.ts"));
  await f.commit();
  assert.equal((await f.candidate()).state, "rejected");
});

test("failed staged revision is durable and not rebuilt on every poll", async (t) => {
  const f = await fixture(t);
  await f.write("packages/app/src/view.ts", "new");
  await f.commit();
  const candidate = await f.candidate();
  let stages = 0,
    queues = 0;
  const d = createDiscovery({
    config: f.config,
    control: f.control,
    readCurrent: async () => f.current,
    fetch: async () => ({ repository: f.repository, candidateRevision: candidate.revision }),
    stageRenderer: async () => {
      stages++;
      throw new Error("validation-failed");
    },
    queue: async () => {
      queues++;
    },
  });
  assert.equal((await d.pollOnce()).state, "rejected");
  assert.equal((await d.pollOnce()).state, "rejected");
  assert.equal(stages, 1);
  assert.equal(queues, 0);
});

test("validation cannot mutate native bytes and still publish renderer release", async (t) => {
  const f = await fixture(t);
  await f.write("packages/app/src/view.ts", "new");
  await f.commit();
  const candidate = await f.candidate();
  await assert.rejects(
    stageRendererRelease({
      ...f,
      candidate,
      minFreeBytes: 0,
      runChecks: async ({ root }) =>
        fs.writeFile(path.join(root, "packages/server/dist/index.js"), "changed by test"),
      validateLaunch: async () => {},
    }),
    /native or dependency/,
  );
  await verifyRelease(f.releases, f.current.id, f.current.digest);
  assert.deepEqual(await fs.readdir(f.releases), ["base"]);
});

test("default discovery queue atomically rejects a changed installed base", async (t) => {
  const f = await fixture(t);
  await atomicJson(path.join(f.control, "state.json"), {
    current: { id: f.current.id, digest: f.current.digest },
    pending: null,
  });
  const selection = { id: "candidate", digest: "a".repeat(64) };
  await assert.rejects(
    queueDiscoveredRelease(f.control, selection, { baseDigest: "b".repeat(64) }),
    /base changed/,
  );
  const state = await queueDiscoveredRelease(f.control, selection, {
    baseDigest: f.current.digest,
  });
  assert.deepEqual(state.pending, selection);
  await assert.rejects(
    queueDiscoveredRelease(
      f.control,
      { id: "other", digest: "c".repeat(64) },
      { baseDigest: f.current.digest },
    ),
    /Another update/,
  );
});

test("fetched installed revision does not depend on a stale local checkout", async (t) => {
  const f = await fixture(t);
  await f.git("branch", "-M", "main");
  const fetched = await fetchCandidate(
    {
      ...f.config,
      remoteUrl: f.repository,
      sourceRepository: path.join(f.root, "no-longer-existing-source"),
    },
    f.base,
  );
  assert.equal(fetched.candidateRevision, f.base);
  assert.equal(
    (
      await inspectCandidate({
        repository: fetched.repository,
        installedRevision: f.base,
        candidateRevision: f.base,
      })
    ).state,
    "current",
  );
});
