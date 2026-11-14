import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  observeInstalledUpdateControl,
  type InstalledControlIdentity,
  type UpdateControlPublication,
} from "./installed-update-control.js";
import { startUpdateControl } from "./update-control.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function fixture() {
  const userHome = await realpath(await mkdtemp(path.join(tmpdir(), "installed-control-")));
  cleanups.push(() => rm(userHome, { recursive: true, force: true }));
  const home = path.join(userHome, "daemon");
  await mkdir(home, { mode: 0o700 });
  const expected: InstalledControlIdentity = {
    uid: process.getuid!(),
    home,
    serverId: "srv-owned",
    pid: 123,
    startedAt: "current",
    listen: "127.0.0.1:12345",
    version: "0.15.5",
  };
  const root = path.join(userHome, ".paseo-installed"),
    directory = path.join(root, "update-control");
  async function register(values: Partial<InstalledControlIdentity> = {}) {
    await mkdir(root, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const { uid: _uid, ...identity } = { ...expected, ...values };
    await writeFile(
      path.join(root, "daemon.json"),
      JSON.stringify({ schemaVersion: 1, approved: true, ...identity }),
      { mode: 0o600 },
    );
  }
  function publish(publication: UpdateControlPublication) {
    return startUpdateControl({
      directory,
      publication,
      descriptor: {
        version: 1,
        daemonIdentity: "exact-instance",
        generation: "11111111-1111-4111-8111-111111111111",
        workerPid: 456,
        serverId: expected.serverId,
        capabilities: { rendererLease: true, daemonCommit: true },
        ttlMs: 15000,
        instance: {
          pid: expected.pid,
          startedAt: expected.startedAt,
          hostname: "fixture",
          uid: expected.uid,
          bootId: null,
        },
      },
      handle: async () => ({}),
      pollMs: 60_000,
    });
  }
  function observe(overrides: Partial<Parameters<typeof observeInstalledUpdateControl>[0]> = {}) {
    const observer = observeInstalledUpdateControl({
      userHome,
      expected,
      ownsInstance: async () => true,
      publish,
      pollMs: 0,
      ...overrides,
    });
    cleanups.push(() => observer.close());
    return observer;
  }
  return { userHome, root, directory, expected, register, observe, publish };
}
it("does not mutate shared roots before exact provisioning, then publishes without restarting", async () => {
  const f = await fixture(),
    observer = f.observe();
  expect(await observer.poll()).toBe(false);
  expect(await readdir(f.userHome)).toEqual(["daemon"]);
  await f.register();
  expect(await observer.poll()).toBe(true);
  expect(
    JSON.parse(await readFile(path.join(f.directory, "descriptor.json"), "utf8")).serverId,
  ).toBe("srv-owned");
});
it("inherited installed intent for foreign home, host, PID, start or version cannot publish", async () => {
  const f = await fixture();
  for (const mismatch of [
    { home: path.join(f.userHome, "foreign") },
    { serverId: "test-host" },
    { pid: 999 },
    { startedAt: "old" },
    { version: "0.15.4" },
  ]) {
    await f.register(mismatch);
    expect(await f.observe().poll()).toBe(false);
    expect(await readdir(f.root)).toEqual(["daemon.json"]);
  }
});
it("waits for verified replacement registration CAS before publishing the next daemon", async () => {
  const f = await fixture(),
    observer = f.observe();
  await f.register({ version: "0.15.4", pid: 100, startedAt: "old" });
  expect(await observer.poll()).toBe(false);
  await f.register();
  expect(await observer.poll()).toBe(true);
});
it("revalidates registration preimage and actual instance after an asynchronous read", async () => {
  const f = await fixture();
  await f.register();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<boolean>();
  const observer = f.observe({
    ownsInstance: () => {
      entered.resolve();
      return release.promise;
    },
  });
  const pending = observer.poll();
  await entered.promise;
  await f.register({ pid: 999 });
  release.resolve(true);
  expect(await pending).toBe(false);
  expect(await readdir(f.root)).toEqual(["daemon.json"]);
});
it("disposal during instance validation cannot create a controller", async () => {
  const f = await fixture();
  await f.register();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<boolean>();
  const observer = f.observe({
    ownsInstance: () => {
      entered.resolve();
      return release.promise;
    },
  });
  const pending = observer.poll();
  await entered.promise;
  const close = observer.close();
  release.resolve(true);
  expect(await pending).toBe(false);
  await close;
  expect(await readdir(f.root)).toEqual(["daemon.json"]);
});
it("disposal or registration change during publication cannot publish stale descriptors", async () => {
  for (const dispose of [false, true]) {
    const f = await fixture();
    await f.register();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const observer = f.observe({
      publish: async (guard) => {
        entered.resolve();
        await release.promise;
        return f.publish(guard);
      },
    });
    const pending = observer.poll();
    await entered.promise;
    const close = dispose ? observer.close() : null;
    if (!dispose) await f.register({ pid: 999 });
    release.resolve();
    expect(await pending).toBe(false);
    await close;
    expect(await readdir(f.root)).toEqual(["daemon.json"]);
  }
});
it("does not publish when it no longer owns the daemon PID lock", async () => {
  const f = await fixture();
  await f.register();
  expect(await f.observe({ ownsInstance: async () => false }).poll()).toBe(false);
  expect(await readdir(f.root)).toEqual(["daemon.json"]);
});
it("never deletes a replacement lock or reports lost authority as successful publication", async () => {
  const f = await fixture();
  await f.register();
  const lock = path.join(f.root, "provision.lock");
  const observer = f.observe({
    publish: async () => {
      await rm(lock, { recursive: true });
      await mkdir(lock, { mode: 0o700 });
      await writeFile(path.join(lock, "foreign"), "preserve");
      return { close: async () => {} };
    },
  });
  expect(await observer.poll()).toBe(false);
  expect(await readFile(path.join(lock, "foreign"), "utf8")).toBe("preserve");
});
it("missing publication lock cannot mask the primary publication failure", async () => {
  const f = await fixture();
  await f.register();
  const observer = f.observe({
    publish: async () => {
      await rm(path.join(f.root, "provision.lock"), { recursive: true });
      throw Error("primary publication failure");
    },
  });
  await expect(observer.poll()).rejects.toThrow("primary publication failure");
});
