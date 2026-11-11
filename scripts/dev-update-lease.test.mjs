import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDaemonUpdateLease, matchesLeaseDaemon } from "./dev-update-lease.mjs";

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paseo-lease-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "daemon-control");
  const instance = {
    pid: 41,
    startedAt: "test-start",
    hostname: "test-host",
    uid: process.getuid(),
    bootId: "boot",
  };
  const descriptor = {
    version: 1,
    instance,
    generation: "generation",
    workerPid: 42,
    capabilities: { rendererLease: true },
  };
  descriptor.daemonIdentity = JSON.stringify({
    ...instance,
    workerPid: 42,
    generation: "generation",
  });
  for (const name of ["", "generation", "generation/requests", "generation/responses"])
    await fs.mkdir(path.join(directory, name), { mode: 0o700 });
  const descriptorPath = path.join(directory, "descriptor.json");
  const writeDescriptor = () =>
    fs.writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  await writeDescriptor();
  const operations = [];
  const transport = async (request) => {
    operations.push(request.operation);
    if (request.operation === "abort") return { released: true };
    return {
      ...(request.binding ?? request.ticket),
      token: "token",
      epoch: 1,
      expiresAt: Date.now() + 15000,
    };
  };
  const options = {
    control: root,
    instance,
    candidateDigest: "a".repeat(64),
    transport,
    heartbeatMs: 100000,
    timeoutMs: 500,
  };
  return {
    root,
    directory,
    instance,
    descriptor,
    descriptorPath,
    writeDescriptor,
    operations,
    transport,
    options,
  };
}

test("prepare inspect commit abort are serialized and release idempotent", async (t) => {
  const f = await fixture(t);
  let active = 0,
    peak = 0;
  const lease = await createDaemonUpdateLease({
    ...f.options,
    transport: async (r) => {
      peak = Math.max(peak, ++active);
      await delay(2);
      const value = await f.transport(r);
      active--;
      return value;
    },
  });
  await Promise.all([lease.check(), lease.commit()]);
  await Promise.all([lease.release(), lease.release()]);
  assert.equal(peak, 1);
  assert.deepEqual(f.operations, ["prepare", "inspect", "commit", "abort"]);
});

test("inspect phase metadata is not sent in strict renew commit or abort tickets", async (t) => {
  const f = await fixture(t);
  let renewed;
  const renewal = new Promise((resolve) => {
    renewed = resolve;
  });
  const lease = await createDaemonUpdateLease({
    ...f.options,
    heartbeatMs: 10,
    transport: async (request) => {
      if (request.ticket)
        assert.deepEqual(
          Object.keys(request.ticket).sort(),
          ["mode", "daemonIdentity", "candidateDigest", "token", "expiresAt", "epoch"].sort(),
        );
      const result = await f.transport(request);
      if (request.operation === "renew") renewed();
      return request.operation === "inspect" ? { ...result, phase: "prepared" } : result;
    },
  });
  try {
    await lease.check();
    await Promise.race([
      renewal,
      delay(500).then(() => {
        throw new Error("Missing renewal");
      }),
    ]);
    await lease.commit();
    await lease.release();
    assert.ok(f.operations.indexOf("renew") > f.operations.indexOf("inspect"));
  } finally {
    await lease.release();
  }
});

test("legacy malformed and identity mismatch descriptors fail closed", async (t) => {
  const f = await fixture(t);
  assert.equal(matchesLeaseDaemon({}, {}), false);
  for (const update of [
    { version: 0 },
    { workerPid: -1 },
    { capabilities: {} },
    { daemonIdentity: "wrong" },
  ]) {
    const original = { ...f.descriptor };
    Object.assign(f.descriptor, update);
    await f.writeDescriptor();
    await assert.rejects(createDaemonUpdateLease(f.options));
    Object.assign(f.descriptor, original);
  }
  await fs.writeFile(f.descriptorPath, "{", { mode: 0o600 });
  await assert.rejects(createDaemonUpdateLease(f.options));
  assert.deepEqual(f.operations, []);
});

test("symlink records and nonprivate directories rejected without repairing them", async (t) => {
  const f = await fixture(t);
  await fs.rename(f.descriptorPath, `${f.descriptorPath}.real`);
  await fs.symlink(`${f.descriptorPath}.real`, f.descriptorPath);
  await assert.rejects(createDaemonUpdateLease(f.options));
  await fs.unlink(f.descriptorPath);
  await fs.rename(`${f.descriptorPath}.real`, f.descriptorPath);
  await fs.chmod(path.join(f.directory, "generation"), 0o755);
  await assert.rejects(createDaemonUpdateLease(f.options), /Unsafe/);
});

test("descriptor replacement during response wait is rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createDaemonUpdateLease({
      ...f.options,
      transport: async (request) => {
        const result = await f.transport(request);
        f.descriptor.generation = "replacement";
        await f.writeDescriptor();
        return result;
      },
    }),
    /generation changed/,
  );
});

test("invalid and changed ticket rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createDaemonUpdateLease({
      ...f.options,
      transport: async (r) => ({ ...(await f.transport(r)), expiresAt: 0 }),
    }),
    /expired/,
  );
  const lease = await createDaemonUpdateLease({
    ...f.options,
    transport: async (r) => {
      const value = await f.transport(r);
      return r.operation === "inspect" ? { ...value, token: "stale" } : value;
    },
  });
  await assert.rejects(lease.check(), /Invalid/);
  assert.match((await lease.failure).failure, /Invalid/);
  await lease.release();
});

test("heartbeat failure reports loss; release cannot restart heartbeat", async (t) => {
  const f = await fixture(t);
  const lease = await createDaemonUpdateLease({
    ...f.options,
    heartbeatMs: 2,
    transport: async (r) => {
      if (r.operation === "renew") throw new Error("renew failed");
      return f.transport(r);
    },
  });
  const keeper = delay(30);
  assert.equal((await lease.failure).failure, "renew failed");
  await lease.release();
  await keeper;
  assert.equal(f.operations.at(-1), "abort");
});

test("release racing an in-flight renewal stops subsequent renewals", async (t) => {
  const f = await fixture(t);
  let started, finish;
  const beginning = new Promise((r) => {
    started = r;
  });
  const wait = new Promise((r) => {
    finish = r;
  });
  const lease = await createDaemonUpdateLease({
    ...f.options,
    heartbeatMs: 2,
    transport: async (r) => {
      if (r.operation === "renew") {
        started();
        await wait;
      }
      return f.transport(r);
    },
  });
  const keeper = delay(40);
  await beginning;
  const released = lease.release();
  finish();
  await released;
  await keeper;
  assert.deepEqual(f.operations, ["prepare", "renew", "abort"]);
});

test("real mailbox rejects a stale response id", async (t) => {
  const f = await fixture(t);
  let running = true;
  const writer = (async () => {
    for (;;) {
      if (!running) break;
      const names = (await fs.readdir(path.join(f.directory, "generation/requests"))).filter(
        (name) => /^[a-f0-9-]+\.json$/.test(name),
      );
      if (names.length) {
        await fs.writeFile(
          path.join(f.directory, "generation/responses", names[0]),
          JSON.stringify({ version: 1, id: "stale", ok: true }),
          { mode: 0o600 },
        );
        return;
      }
      await delay(2);
    }
  })();
  try {
    await assert.rejects(
      createDaemonUpdateLease({ ...f.options, transport: undefined }),
      /Invalid daemon update response/,
    );
  } finally {
    running = false;
    await writer;
  }
});

test("reclamation requires advertised capability and sends only identity and registration", async (t) => {
  const { reclaimManagedDependencies } = await import("./dev-update-lease.mjs");
  const f = await fixture(t);
  const request = {
    control: f.root,
    instance: f.instance,
    registryId: "b".repeat(64),
    evidence: { sourceRevision: "c".repeat(40), releaseDigest: "d".repeat(64) },
  };
  await assert.rejects(reclaimManagedDependencies(request), /does not support/);
  f.descriptor.capabilities.managedDependencyRetirement = true;
  await f.writeDescriptor();
  const receipt = await reclaimManagedDependencies({
    ...request,
    transport: async (value) => {
      assert.equal(value.operation, "reclaimDependencies");
      assert.equal(value.daemonIdentity, f.descriptor.daemonIdentity);
      assert.equal(value.registryId, request.registryId);
      assert.equal(value.root, undefined);
      assert.equal(value.ticket, undefined);
      return { detached: true, transactionId: "retire-1", purgePending: true };
    },
  });
  assert.equal(receipt.transactionId, "retire-1");
});

test("reclamation timeout and changed identity report uncertainty without retry", async (t) => {
  const { reclaimManagedDependencies } = await import("./dev-update-lease.mjs");
  const f = await fixture(t);
  f.descriptor.capabilities.managedDependencyRetirement = true;
  await f.writeDescriptor();
  const request = {
    control: f.root,
    instance: f.instance,
    registryId: "b".repeat(64),
    evidence: { sourceRevision: "c".repeat(40), releaseDigest: "d".repeat(64) },
  };
  let calls = 0;
  await assert.rejects(
    reclaimManagedDependencies({
      ...request,
      timeoutMs: 5,
      transport: async () => {
        calls++;
        return new Promise(() => {});
      },
    }),
    /outcome unknown/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    reclaimManagedDependencies({
      ...request,
      transport: async () => {
        f.descriptor.generation = "changed";
        await f.writeDescriptor();
        return { detached: true, transactionId: "retire-1", purgePending: true };
      },
    }),
    /changed/,
  );
});

test("reclamation mailbox validates result and never accepts arbitrary paths", async (t) => {
  const { reclaimManagedDependencies } = await import("./dev-update-lease.mjs");
  const f = await fixture(t);
  f.descriptor.capabilities.managedDependencyRetirement = true;
  await f.writeDescriptor();
  await assert.rejects(
    reclaimManagedDependencies({
      control: f.root,
      instance: f.instance,
      registryId: "../target",
      evidence: { sourceRevision: "c".repeat(40), releaseDigest: "d".repeat(64) },
    }),
    /Invalid managed/,
  );
  await assert.rejects(
    reclaimManagedDependencies({
      control: f.root,
      instance: f.instance,
      registryId: "b".repeat(64),
      evidence: { sourceRevision: "c".repeat(40), releaseDigest: "d".repeat(64) },
      transport: async () => ({ detached: false }),
    }),
    /Invalid dependency detach/,
  );
});
