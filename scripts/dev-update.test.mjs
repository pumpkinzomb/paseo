import assert from "node:assert/strict";
import { AutomaticUpdateController } from "./dev-update-automatic.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  atomicJson,
  acquireLock,
  privateDirectory,
  scanRelease,
  detachStagingHardlinks,
  manifestDigest,
  verifyRelease,
  isRendererOnly,
  queueRelease,
  readJson,
} from "./dev-update-store.mjs";
import {
  runtimeEnvironment,
  matchesDaemonOwnership,
  validateManagedSettings,
  assertRuntimeArtifacts,
  captureBootstrapDaemon,
  electronExecutable,
  validateConfig,
  validateRuntimePaths,
  spawnOwned,
  runSupervisor,
} from "./dev-update-runtime.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "paseo-update-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releases = path.join(root, "releases"),
    control = path.join(root, "control");
  await fs.mkdir(releases);
  await privateDirectory(control);
  return { root, releases, control };
}
async function release(releases, id, contents = {}) {
  const root = path.join(releases, id);
  await fs.mkdir(root);
  for (const [file, content] of Object.entries({
    "packages/app/src/view.ts": "first",
    "packages/server/dist/index.js": "server",
    ...contents,
  })) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  const manifest = {
    schemaVersion: 1,
    id,
    sourceRevision: "a".repeat(40),
    stateCompatibility: "preserve",
    entries: await scanRelease(root),
  };
  await atomicJson(path.join(root, "release.json"), manifest);
  return { id, digest: manifestDigest(manifest), manifest, root };
}
const selection = ({ id, digest }) => ({ id, digest });
async function initialized(t, changes) {
  const f = await fixture(t);
  f.before = await release(f.releases, "old");
  f.after = await release(f.releases, "new", changes);
  f.config = {
    schemaVersion: 1,
    serverId: "stable",
    releases: f.releases,
    home: path.join(f.root, "home"),
    userData: path.join(f.root, "profile"),
    daemonPort: 16781,
    metroPort: 18091,
  };
  await atomicJson(path.join(f.control, "config.json"), f.config);
  await atomicJson(path.join(f.control, "state.json"), {
    schemaVersion: 1,
    current: selection(f.before),
    pending: null,
    previous: null,
    transition: null,
  });
  return f;
}

export function registerDevUpdateTests() {
  test("retained readiness requires exact generation-bound ownership receipt", () => {
    const instance = {
      pid: 123,
      startedAt: "start",
      uid: 501,
      hostname: "host",
      serverId: "srv",
      desktopManaged: true,
      listen: "127.0.0.1:6781",
    };
    const receipt = { schemaVersion: 1, generation: "current", instance };
    assert.equal(matchesDaemonOwnership(receipt, "current", instance), true);
    for (const value of [
      null,
      {},
      { ...receipt, schemaVersion: 2 },
      { ...receipt, generation: "stale" },
      { ...receipt, instance: {} },
    ])
      assert.equal(matchesDaemonOwnership(value, "current", instance), false);
    for (const key of Object.keys(instance))
      assert.equal(
        matchesDaemonOwnership(
          { ...receipt, instance: { ...instance, [key]: "wrong" } },
          "current",
          instance,
        ),
        false,
      );
  });
  test("complete manifests reject additions, changed files and changed approval", async (t) => {
    const f = await fixture(t),
      r = await release(f.releases, "one");
    await verifyRelease(f.releases, r.id, r.digest);
    await assert.rejects(verifyRelease(f.releases, r.id, "0".repeat(64)), /approval digest/);
    await fs.writeFile(path.join(r.root, "extra.js"), "unapproved");
    await assert.rejects(verifyRelease(f.releases, r.id, r.digest), /contents changed/);
    await fs.unlink(path.join(r.root, "extra.js"));
    await fs.writeFile(path.join(r.root, "packages/app/src/view.ts"), "changed");
    await assert.rejects(verifyRelease(f.releases, r.id, r.digest), /contents changed/);
  });
  test("Metro-generated type references do not invalidate immutable runtime inputs", async (t) => {
    const f = await fixture(t),
      r = await release(f.releases, "one");
    await fs.writeFile(
      path.join(r.root, "packages/app/expo-env.d.ts"),
      '/// <reference types="expo/types" />',
    );
    await verifyRelease(f.releases, r.id, r.digest);
  });
  test("release trees reject escaping symlinks, aliases and shared hardlinks", async (t) => {
    const f = await fixture(t),
      r = await release(f.releases, "one");
    await fs.symlink(f.control, path.join(r.root, "outside"));
    await assert.rejects(scanRelease(r.root), /link escapes/);
    await fs.unlink(path.join(r.root, "outside"));
    await fs.link(
      path.join(r.root, "packages/server/dist/index.js"),
      path.join(r.root, "shared.js"),
    );
    await assert.rejects(scanRelease(r.root), /Shared hardlink/);
  });
  test("runtime preflight rejects a lazy Electron package without its executable", async (t) => {
    const f = await fixture(t);
    await assert.rejects(assertRuntimeArtifacts(f.root), /ENOENT/);
    const executable = electronExecutable(f.root);
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "fixture", { mode: 0o755 });
    for (const relative of [
      "packages/desktop/dist/main.js",
      "packages/desktop/dist/preload.js",
      "packages/server/dist/scripts/supervisor-entrypoint.js",
      "node_modules/expo/bin/cli",
      "packages/app/package.json",
    ]) {
      const file = path.join(f.root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "fixture");
    }
    await assertRuntimeArtifacts(f.root);
  });
  test("staging detaches npm hardlinks without changing shared source data", async (t) => {
    const f = await fixture(t),
      r = await release(f.releases, "one");
    const source = path.join(f.root, "external-binary");
    const staged = path.join(r.root, "binary");
    await fs.writeFile(source, "original", { mode: 0o755 });
    await fs.link(source, staged);
    await fs.link(staged, path.join(r.root, "binary-alias"));
    assert.equal(await detachStagingHardlinks(r.root), 2);
    assert.equal((await fs.stat(staged)).nlink, 1);
    assert.equal((await fs.stat(staged)).mode & 0o777, 0o755);
    await fs.writeFile(staged, "changed");
    assert.equal(await fs.readFile(source, "utf8"), "original");
    assert.equal(await fs.readFile(path.join(r.root, "binary-alias"), "utf8"), "original");
    await scanRelease(r.root);
  });
  test("renderer-only classification includes removed and added backend files and dependencies", async (t) => {
    const f = await fixture(t),
      a = await release(f.releases, "a");
    const b = await release(f.releases, "b", { "packages/app/src/view.ts": "new" });
    assert.equal(isRendererOnly(a.manifest, b.manifest), true);
    const c = await release(f.releases, "c", { "node_modules/thing/index.js": "new" });
    assert.equal(isRendererOnly(a.manifest, c.manifest), false);
    assert.equal(isRendererOnly(c.manifest, a.manifest), false);
    const d = await release(f.releases, "d", { "packages/app/metro.config.js": "changed" });
    assert.equal(isRendererOnly(a.manifest, d.manifest), false);
  });
  test("locks are exclusive, retained without age expiry, and identity fenced", async (t) => {
    const f = await fixture(t);
    const unlock = await acquireLock(f.control, "lock");
    await assert.rejects(acquireLock(f.control, "lock"), /Never auto-clear/);
    await atomicJson(path.join(f.control, "lock"), { token: "different" });
    await assert.rejects(unlock(), /ownership changed/);
    assert.equal((await readJson(path.join(f.control, "lock"))).token, "different");
  });
  test("private control directories reject permissions and symlink aliases", async (t) => {
    const f = await fixture(t);
    await fs.chmod(f.control, 0o755);
    await assert.rejects(privateDirectory(f.control), /0700/);
    const alias = path.join(f.root, "alias");
    await fs.symlink(f.control, alias);
    await assert.rejects(privateDirectory(alias), /0700|aliases/);
  });
  test("queue is idempotent but cannot overwrite a pending or interrupted deployment", async (t) => {
    const f = await initialized(t, { "packages/app/src/view.ts": "new" });
    await queueRelease(f.control, selection(f.after));
    await queueRelease(f.control, selection(f.after));
    await assert.rejects(queueRelease(f.control, { id: "other", digest: "b" }), /already pending/);
    const state = await readJson(path.join(f.control, "state.json"));
    state.transition = { phase: "starting" };
    await atomicJson(path.join(f.control, "state.json"), state);
    await assert.rejects(queueRelease(f.control, selection(f.after)), /reconciliation/);
  });
  test("runtime environment fixes endpoints and clears inherited seed/reset injection", () => {
    const config = {
      home: "/safe/home",
      userData: "/safe/profile",
      daemonPort: 16781,
      metroPort: 18091,
    };
    const env = runtimeEnvironment(config, "/control/generation", "gen", {
      HOME: "/home",
      PASEO_HOME: "/live",
      PASEO_DEV_SEED_HOME: "/live",
      EXPO_PORT: "6767",
      NODE_OPTIONS: "--inspect",
      ELECTRON_RUN_AS_NODE: "1",
    });
    assert.equal(env.PASEO_HOME, "/safe/home");
    assert.equal(env.PASEO_DEV_SEED_HOME, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.EXPO_DEV_URL, "http://localhost:18091");
    assert.equal(env.EXPO_PUBLIC_LOCAL_DAEMON, undefined);
    assert.equal(env.PASEO_DEV_UPDATE_GENERATION, "gen");
  });
  test("managed runtime validates persisted listen and CORS before launching", () => {
    const config = { daemonPort: 19781, metroPort: 19091 };
    assert.throws(() => validateManagedSettings(config, {}), /persisted listen/);
    assert.throws(
      () => validateManagedSettings(config, { daemon: { listen: "127.0.0.1:19781" } }),
      /CORS/,
    );
    validateManagedSettings(config, {
      daemon: { listen: "127.0.0.1:19781", cors: { allowedOrigins: ["http://localhost:19091"] } },
    });
  });
  test("configuration refuses port collisions and relative state paths", () => {
    assert.throws(
      () =>
        validateConfig({
          schemaVersion: 1,
          releases: "/r",
          home: "/h",
          userData: "/u",
          daemonPort: 3000,
          metroPort: 3000,
        }),
      /collide/,
    );
    assert.throws(() => validateConfig({ schemaVersion: 1, releases: "relative" }), /absolute/);
  });

  // Real independent Node children exercise exit/relaunch. No live Paseo state,
  // providers, ports or Electron profile are used by this process integration.
  async function childRuntime(t, { ready, handoff, exitCode = 0 }) {
    const owned = spawnOwned(
      process.execPath,
      [
        "-e",
        `process.send('started'); process.on('message', () => process.exit(${exitCode})); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    t.after(async () => {
      if (!owned.closedAlready) {
        owned.child.kill("SIGTERM");
        await owned.closed;
      }
    });
    await once(owned.child, "message");
    return {
      exited: owned.closed,
      isExited: () => owned.closedAlready,
      stopMetro: async () => {},
      ready: async () => ready?.(owned),
      requestHandoff: async () => {
        await handoff?.(owned);
      },
      handoffResult: async () => ({ state: "ready" }),
    };
  }
  test("renderer update exits owned child then relaunches and commits while preserving daemon", async (t) => {
    const f = await initialized(t, { "packages/app/src/view.ts": "new" });
    await atomicJson(path.join(f.control, "config.json"), {
      ...f.config,
      selfDevelopmentPolicy: { labRoot: f.root },
    });
    const maintenance = [];
    let inspected = false;
    const launches = [],
      daemon = { pid: 987, startedAt: "fixture", serverId: "stable" };
    await queueRelease(f.control, selection(f.after));
    await runSupervisor(f.control, {
      pollMs: 5,
      runMaintenance: async (request) => maintenance.push(request),
      inspectDaemon: async () => {
        const value = inspected ? daemon : null;
        inspected = true;
        return value;
      },
      launch: async (_config, root, _control, options) => {
        if (launches.length === 0) assert.equal(options.daemonHandoff, null);
        else assert.deepEqual(options.daemonHandoff, daemon);
        launches.push(root);
        return childRuntime(t, {
          ready: (owned) => {
            if (launches.length === 2) owned.child.send("quit");
          },
          handoff: (owned) => owned.child.send("quit"),
        });
      },
    });
    assert.deepEqual(
      maintenance.map((x) => x.evidence.releaseDigest),
      [f.before.digest, f.after.digest],
    );
    assert.deepEqual(launches, [f.before.root, f.after.root]);
    assert.deepEqual(await readJson(path.join(f.control, "state.json")), {
      schemaVersion: 1,
      current: selection(f.after),
      previous: selection(f.before),
      pending: null,
      transition: null,
    });
  });
  test("automatic renderer handoff holds authoritative lease until replacement readiness", async (t) => {
    const f = await initialized(t, { "packages/app/src/view.ts": "new" });
    await atomicJson(path.join(f.control, "config.json"), {
      ...f.config,
      automaticUpdates: { enabled: true },
    });
    await queueRelease(f.control, selection(f.after));
    const daemon = {
      pid: 456,
      startedAt: "fixture",
      uid: 501,
      hostname: "fixture",
      serverId: "stable",
      desktopManaged: true,
      listen: "127.0.0.1:16781",
    };
    const events = [];
    let launches = 0;
    await runSupervisor(f.control, {
      pollMs: 5,
      inspectDaemon: async () => (launches ? daemon : null),
      createAutomatic: () =>
        new AutomaticUpdateController({
          createLease: async () => ({
            identity: "fixture",
            check: async () => true,
            commit: async () => {
              events.push("lease-commit");
            },
            release: async () => {
              events.push("lease-release");
            },
          }),
        }),
      launch: async (_config, _root, _control, options) => {
        launches++;
        const currentLaunch = launches;
        let ownedChild, receipt;
        const runtime = await childRuntime(t, {
          ready: (owned) => {
            ownedChild = owned;
            if (currentLaunch === 2) {
              assert.deepEqual(options.daemonHandoff, daemon);
              assert.equal(events.includes("lease-release"), false);
              events.push("replacement-ready");
              owned.child.send("quit");
            }
          },
          handoff: () => assert.fail("no voluntary-close legacy path"),
        });
        return {
          ...runtime,
          generation: `generation-${currentLaunch}`,
          supportsAutomaticHandoff: true,
          requestAutomaticHandoff: async (request) => {
            receipt = {
              ...request,
              generation: `generation-${currentLaunch}`,
              state: request.phase === "prepare" ? "prepared" : "ready",
              prepareToken: "token",
              activityEpoch: 1,
            };
            if (request.phase === "commit") {
              events.push("native-commit");
              ownedChild.child.send("quit");
            }
          },
          automaticHandoffResult: async () => receipt,
        };
      },
    });
    assert.equal(launches, 2);
    assert.deepEqual(events, [
      "lease-commit",
      "native-commit",
      "replacement-ready",
      "lease-release",
    ]);
    assert.equal((await readJson(path.join(f.control, "state.json"))).current.id, "new");
  });
  test("automatic updates require explicit opt-in and reject daemon mode", () => {
    const config = {
      schemaVersion: 1,
      releases: "/r",
      home: "/h",
      userData: "/u",
      serverId: "s",
      daemonPort: 19001,
      metroPort: 19002,
    };
    validateConfig(config);
    validateConfig({ ...config, automaticUpdates: { enabled: true, mode: "renderer" } });
    assert.throws(
      () => validateConfig({ ...config, automaticUpdates: { enabled: true, mode: "full" } }),
      /not supported/,
    );
    assert.throws(
      () =>
        validateConfig({
          ...config,
          automaticUpdates: { enabled: false, discovery: { enabled: true } },
        }),
      /separately/,
    );
    assert.equal(
      runtimeEnvironment(
        { ...config, automaticUpdates: { enabled: true } },
        "/control/generation-one",
        "one",
      ).PASEO_DEV_UPDATE_DAEMON_CONTROL,
      "/control/daemon-control",
    );
    assert.equal(
      runtimeEnvironment(config, "/control/generation-one", "one").PASEO_DEV_UPDATE_DAEMON_CONTROL,
      undefined,
    );
  });
  test("full update does not request handoff and relaunches only after normal quit with no daemon", async (t) => {
    const f = await initialized(t, { "packages/server/dist/index.js": "new server" });
    await queueRelease(f.control, selection(f.after));
    let launches = 0;
    await runSupervisor(f.control, {
      pollMs: 5,
      inspectDaemon: async () => null,
      launch: async () => {
        launches++;
        return childRuntime(t, {
          ready: (owned) => owned.child.send("quit"),
          handoff: () => assert.fail("Full update must never force handoff"),
        });
      },
    });
    assert.equal(launches, 2);
    assert.equal((await readJson(path.join(f.control, "state.json"))).current.id, "new");
  });
  test("full update with surviving daemon remains pending and does not restart or kill it", async (t) => {
    const f = await initialized(t, { "packages/server/dist/index.js": "new server" });
    await queueRelease(f.control, selection(f.after));
    let launches = 0;
    await runSupervisor(f.control, {
      pollMs: 5,
      inspectDaemon: async () => (launches ? { pid: 987 } : null),
      launch: async () => {
        launches++;
        return childRuntime(t, { ready: (owned) => owned.child.send("quit") });
      },
    });
    assert.equal(launches, 1);
    assert.equal((await readJson(path.join(f.control, "state.json"))).current.id, "old");
    assert.equal(
      (await readJson(path.join(f.control, "status.json"))).state,
      "waiting-for-daemon-stop",
    );
  });
  test("crashed desktop does not trigger full update or claim success", async (t) => {
    const f = await initialized(t, { "packages/server/dist/index.js": "new server" });
    await queueRelease(f.control, selection(f.after));
    let launches = 0;
    await runSupervisor(f.control, {
      pollMs: 5,
      inspectDaemon: async () => null,
      launch: async () => {
        launches++;
        return childRuntime(t, { ready: (owned) => owned.child.send("quit"), exitCode: 1 });
      },
    });
    assert.equal(launches, 1);
    assert.equal((await readJson(path.join(f.control, "status.json"))).state, "interrupted");
  });
  test("lost readiness leaves a durable transition and never rolls user data backward", async (t) => {
    const f = await initialized(t, { "packages/app/src/view.ts": "new" });
    await atomicJson(path.join(f.control, "config.json"), {
      ...f.config,
      selfDevelopmentPolicy: { labRoot: f.root },
    });
    const maintenance = [];
    await queueRelease(f.control, selection(f.after));
    let launches = 0;
    await assert.rejects(
      runSupervisor(f.control, {
        pollMs: 5,
        runMaintenance: async (request) => maintenance.push(request),
        inspectDaemon: async () => null,
        launch: async () => {
          launches++;
          return childRuntime(t, {
            ready: () => {
              if (launches === 2) throw new Error("no ready");
            },
            handoff: (owned) => owned.child.send("quit"),
          });
        },
      }),
      /no ready/,
    );
    assert.deepEqual(
      maintenance.map((x) => x.evidence.releaseDigest),
      [f.before.digest],
    );
    const state = await readJson(path.join(f.control, "state.json"));
    assert.equal(state.current.id, "old");
    assert.equal(state.transition.to.id, "new");
    assert.equal((await readJson(path.join(f.control, "status.json"))).state, "recovery-required");
    await assert.rejects(runSupervisor(f.control), /Lock exists/);
  });

  test("overlapping state, control and release paths are rejected before launch", async (t) => {
    const f = await initialized(t, {});
    await assert.rejects(
      validateRuntimePaths({ ...f.config, home: f.control }, f.control),
      /overlap/,
    );
    await assert.rejects(
      validateRuntimePaths({ ...f.config, userData: path.join(f.releases, "profile") }, f.control),
      /overlap/,
    );
  });
  test("initial supervisor refuses an existing daemon instead of silently adopting it", async (t) => {
    const f = await initialized(t, {});
    await assert.rejects(
      runSupervisor(f.control, {
        inspectDaemon: async () => ({ pid: 123 }),
        launch: () => assert.fail("must not launch"),
      }),
      /normally stopped/,
    );
  });
  test("explicit bootstrap captures a matching live identity once, without stopping it", async (t) => {
    const f = await initialized(t, {});
    const daemon = {
      pid: 123,
      startedAt: "fixture",
      desktopManaged: true,
      listen: "127.0.0.1:16781",
      serverId: "stable",
      uid: process.getuid(),
    };
    const bootstrap = await captureBootstrapDaemon(
      f.config,
      { root: f.before.root, digest: f.before.digest },
      async () => daemon,
    );
    const state = await readJson(path.join(f.control, "state.json"));
    await atomicJson(path.join(f.control, "state.json"), { ...state, bootstrap });
    await runSupervisor(f.control, {
      inspectDaemon: async () => daemon,
      launch: async (_config, _root, _control, options) => {
        assert.deepEqual(options.daemonHandoff, daemon);
        return childRuntime(t, { ready: (owned) => owned.child.send("quit") });
      },
    });
    assert.equal((await readJson(path.join(f.control, "state.json"))).bootstrap, undefined);
  });
  test("bootstrap cannot adopt a different daemon or resurrect a missing daemon", async (t) => {
    const f = await initialized(t, {});
    const state = await readJson(path.join(f.control, "state.json"));
    await atomicJson(path.join(f.control, "state.json"), {
      ...state,
      bootstrap: { selectionDigest: f.before.digest, instance: { pid: 123 } },
    });
    await assert.rejects(
      runSupervisor(f.control, {
        inspectDaemon: async () => ({ pid: 456 }),
        launch: () => assert.fail("must not launch"),
      }),
      /normally stopped/,
    );
    await assert.rejects(
      runSupervisor(f.control, {
        inspectDaemon: async () => null,
        launch: () => assert.fail("must not launch"),
      }),
      /no longer running/,
    );
  });
  test("partial launch failures retain lock because child ownership may be uncertain", async (t) => {
    const f = await initialized(t, {});
    await assert.rejects(
      runSupervisor(f.control, {
        inspectDaemon: async () => null,
        launch: async () => {
          throw new Error("partial launch");
        },
      }),
      /partial launch/,
    );
    await assert.rejects(acquireLock(f.control, "supervisor.lock"), /Lock exists/);
  });
  test("acknowledged UI handoff detects daemon replacement across exit", async (t) => {
    const f = await initialized(t, { "packages/app/src/view.ts": "new" });
    await queueRelease(f.control, selection(f.after));
    let probes = 0,
      launches = 0;
    await assert.rejects(
      runSupervisor(f.control, {
        pollMs: 5,
        inspectDaemon: async () => {
          probes++;
          return probes === 1 ? null : { pid: probes === 2 ? 100 : 200 };
        },
        launch: async () => {
          launches++;
          return childRuntime(t, { handoff: (owned) => owned.child.send("quit") });
        },
      }),
      /changed across acknowledged/,
    );
    assert.equal(launches, 1);
    assert.equal((await readJson(path.join(f.control, "state.json"))).current.id, "old");
  });
  test("Metro failure is surfaced without killing an active desktop", async (t) => {
    const f = await initialized(t, {});
    await assert.rejects(
      runSupervisor(f.control, {
        pollMs: 5,
        inspectDaemon: async () => null,
        launch: async () => ({
          ...(await childRuntime(t, {})),
          failure: Promise.resolve({ failure: "Metro died" }),
        }),
      }),
      /Metro died/,
    );
    assert.equal((await readJson(path.join(f.control, "status.json"))).state, "recovery-required");
  });

  test("ordinary quit during renderer update may start a fresh daemon", async (t) => {
    const f = await initialized(t, { "packages/app/src/view.ts": "new" });
    await queueRelease(f.control, selection(f.after));
    let launches = 0;
    await runSupervisor(f.control, {
      pollMs: 5,
      inspectDaemon: async () => (launches < 2 ? null : { pid: 456, serverId: "stable" }),
      launch: async () => {
        launches++;
        return childRuntime(t, { ready: (owned) => owned.child.send("quit") });
      },
    });
    assert.equal(launches, 2);
    assert.equal((await readJson(path.join(f.control, "state.json"))).current.id, "new");
  });

  test("real init installs complete controller before publishing selection and never overwrites it", async (t) => {
    const f = await fixture(t),
      r = await release(f.releases, "initial");
    const config = {
      schemaVersion: 1,
      serverId: "stable",
      releases: f.releases,
      home: path.join(f.root, "home"),
      userData: path.join(f.root, "profile"),
      daemonPort: 16781,
      metroPort: 18091,
    };
    const configFile = path.join(f.root, "config.json");
    await atomicJson(configFile, config);
    const command = fileURLToPath(new URL("./dev-update.mjs", import.meta.url));
    const args = [
      command,
      "init",
      "--control",
      f.control,
      "--config",
      configFile,
      "--release",
      r.id,
      "--digest",
      r.digest,
    ];
    const exec = promisify(execFile);
    await exec(process.execPath, args);
    assert.equal((await readJson(path.join(f.control, "state.json"))).current.id, "initial");
    const status = await exec(process.execPath, [
      path.join(f.control, "controller/dev-update.mjs"),
      "status",
      "--control",
      f.control,
    ]);
    assert.equal(JSON.parse(status.stdout).supervisor, null);
    await assert.rejects(exec(process.execPath, args), /Already initialized/);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) registerDevUpdateTests();

test("Finder metadata alone does not invalidate a sealed release", async (t) => {
  const f = await fixture(t);
  const r = await release(f.releases, "finder");
  const metadata = Buffer.alloc(32);
  metadata.writeUInt32BE(1, 0);
  metadata.write("Bud1", 4);
  await fs.writeFile(path.join(r.root, ".DS_Store"), metadata);
  await fs.writeFile(path.join(r.root, "packages/.DS_Store"), metadata);
  await verifyRelease(f.releases, r.id, r.digest);
  await fs.writeFile(path.join(r.root, "unknown"), "extra");
  await assert.rejects(verifyRelease(f.releases, r.id, r.digest), /contents changed/);
  await fs.unlink(path.join(r.root, "unknown"));
  await fs.writeFile(path.join(r.root, "packages/app/src/view.ts"), "changed");
  await assert.rejects(verifyRelease(f.releases, r.id, r.digest), /contents changed/);
});
test("Finder metadata exemption rejects malformed, executable, linked and oversized entries", async (t) => {
  const f = await fixture(t);
  const r = await release(f.releases, "finder-invalid");
  const target = path.join(r.root, ".DS_Store");
  const metadata = Buffer.alloc(32);
  metadata.writeUInt32BE(1, 0);
  metadata.write("Bud1", 4);
  for (const content of [
    Buffer.from("bad"),
    Buffer.alloc(32),
    Buffer.concat([metadata, Buffer.alloc(1024 * 1024)]),
  ]) {
    await fs.writeFile(target, content);
    await assert.rejects(verifyRelease(f.releases, r.id, r.digest), /contents changed/);
  }
  await fs.writeFile(target, metadata);
  await fs.chmod(target, 0o755);
  await assert.rejects(verifyRelease(f.releases, r.id, r.digest), /contents changed/);
  await fs.unlink(target);
  await fs.symlink("packages/app/src/view.ts", target);
  await assert.rejects(verifyRelease(f.releases, r.id, r.digest), /contents changed/);
  await fs.unlink(target);
  await fs.writeFile(target, metadata);
  await fs.link(target, path.join(f.root, "metadata-hardlink"));
  await assert.rejects(verifyRelease(f.releases, r.id, r.digest), /Shared hardlink/);
});
