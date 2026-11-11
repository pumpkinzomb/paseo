import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configuredDiscovery, runDiscoveryWatch } from "./dev-update-watch.mjs";
import {
  privateDirectory,
  atomicJson,
  scanRelease,
  manifestDigest,
  readOptionalJson,
} from "./dev-update-store.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "update-watch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const control = path.join(root, "control"),
    releases = path.join(root, "releases");
  const home = path.join(root, "home"),
    userData = path.join(root, "profile"),
    sourceRepository = path.join(root, "source");
  for (const dir of [control, releases, home, userData, sourceRepository])
    await privateDirectory(dir);
  await atomicJson(path.join(control, "config.json"), { releases, home, userData });
  const releaseRoot = path.join(releases, "one");
  await privateDirectory(releaseRoot);
  await fs.writeFile(path.join(releaseRoot, "input.js"), "fixture");
  const manifest = {
    schemaVersion: 1,
    id: "one",
    sourceRevision: "a".repeat(40),
    stateCompatibility: "preserve",
    entries: await scanRelease(releaseRoot),
  };
  await atomicJson(path.join(releaseRoot, "release.json"), manifest);
  const state = {
    schemaVersion: 1,
    current: { id: "one", digest: manifestDigest(manifest) },
    pending: null,
    transition: null,
  };
  await atomicJson(path.join(control, "state.json"), state);
  const config = {
    enabled: true,
    remoteUrl: "https://github.com/pumpkinzomb/paseo.git",
    ref: "refs/heads/main",
    cacheRoot: path.join(root, "cache"),
    sourceRepository,
  };
  return { root, control, config, state, releaseRoot };
}
test("watch is opt-in and does not touch the existing app selection", async (t) => {
  const f = await fixture(t);
  assert.equal(await configuredDiscovery(f.control), null);
  await atomicJson(path.join(f.control, "update-discovery.json"), { enabled: false });
  assert.equal(await configuredDiscovery(f.control), null);
  assert.deepEqual(await readOptionalJson(path.join(f.control, "state.json")), f.state);
});
test("configured watch reads latest selection and supplies isolated validation/full-stage ports", async (t) => {
  const f = await fixture(t);
  await atomicJson(path.join(f.control, "update-discovery.json"), f.config);
  let ports, validation, full;
  const watch = await configuredDiscovery(f.control, {
    factory: (options) => {
      ports = options;
      return { marker: true };
    },
    validateLaunch: (options) => {
      validation = options;
    },
    stageFull: (options) => {
      full = options;
    },
  });
  assert.equal(watch.marker, true);
  assert.equal((await ports.readCurrent()).manifest.sourceRevision, "a".repeat(40));
  await atomicJson(path.join(f.control, "state.json"), {
    ...f.state,
    pending: { id: "two", digest: "b" },
  });
  assert.equal((await ports.readCurrent()).pending.id, "two");
  await ports.validateLaunch({ root: "/isolated/candidate" });
  assert.deepEqual(validation, {
    root: "/isolated/candidate",
    workRoot: path.join(f.config.cacheRoot, "validation"),
  });
  await ports.stageFull({ candidate: { revision: "candidate" } });
  assert.deepEqual(full.candidate, { revision: "candidate" });
  assert.ok(full.protectedPaths.includes(f.control));
  assert.ok(full.protectedPaths.includes(f.config.sourceRepository));
});
test("watch refuses changed sealed runtime bytes before using a base", async (t) => {
  const f = await fixture(t);
  await atomicJson(path.join(f.control, "update-discovery.json"), f.config);
  let ports;
  await configuredDiscovery(f.control, {
    factory: (options) => {
      ports = options;
      return {};
    },
  });
  await fs.writeFile(path.join(f.releaseRoot, "input.js"), "changed");
  await assert.rejects(ports.readCurrent(), /contents changed/);
});
test("persistent watcher stops and releases only its own lock without app actions", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  const calls = [];
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const running = runDiscoveryWatch(f.control, {
    signal: controller.signal,
    create: async () => ({
      start() {
        calls.push("start");
        started();
      },
      async stop() {
        calls.push("stop");
      },
    }),
  });
  await ready;
  assert.ok(await readOptionalJson(path.join(f.control, "discovery-watcher.lock")));
  controller.abort();
  await running;
  assert.deepEqual(calls, ["start", "stop"]);
  assert.equal(await readOptionalJson(path.join(f.control, "discovery-watcher.lock")), null);
  assert.deepEqual(await readOptionalJson(path.join(f.control, "state.json")), f.state);
});
