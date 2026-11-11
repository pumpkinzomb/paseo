import { expect, it, vi } from "vitest";
import { reclaimManagedDependencies } from "./managed-dependency-maintenance.js";
import { createUpdateQuiescence, UpdateAdmissionFence } from "./update-quiescence.js";

const input = {
  daemonIdentity: "daemon",
  registryId: "a".repeat(64),
  evidence: {
    sourceRevision: "b".repeat(40),
    releaseDigest: "c".repeat(64),
  },
};
function fixture() {
  const fence = new UpdateAdmissionFence();
  const options = {
    identity: () => "daemon",
    fence,
    runtimes: () => [],
    missingIngressCoverage: () => [] as string[],
    blockers: () => [] as string[],
    stop: vi.fn(async () => {}),
  };
  const quiescence = createUpdateQuiescence(options);
  const commitSync = vi.fn(() => {
    expect(fence.enter()).toBeNull();
    return { transactionId: "retirement" };
  });
  const purge = vi.fn(async () => {
    const leave = fence.enter();
    expect(leave).not.toBeNull();
    leave?.();
  });
  const prepare = vi.fn(async () => ({
    root: "/managed/worktree",
    commitSync,
    purge,
    abortSync: vi.fn(),
  }));
  const deps = {
    daemonIdentity: "daemon",
    registry: "/private/registry",
    prepare,
    quiescence,
    assertNoTerminals: vi.fn(() => {}),
    onPurgeError: vi.fn(),
  };
  return { fence, options, quiescence, commitSync, purge, prepare, deps };
}
it("preflights before fencing and detaches synchronously, releases before purge", async () => {
  const f = fixture();
  expect(await reclaimManagedDependencies(input, f.deps)).toEqual({
    detached: true,
    transactionId: "retirement",
    root: "/managed/worktree",
    purgePending: true,
  });
  expect(f.commitSync).toHaveBeenCalledTimes(1);
  expect(f.purge).toHaveBeenCalledTimes(1);
  expect(f.options.stop).not.toHaveBeenCalled();
});
it("rejects caller paths and mismatched daemon before touching registered artifacts", async () => {
  const f = fixture();
  await expect(
    reclaimManagedDependencies({ ...input, registryId: "../../elsewhere" }, f.deps),
  ).rejects.toThrow();
  await expect(
    reclaimManagedDependencies({ ...input, daemonIdentity: "old" }, f.deps),
  ).rejects.toThrow();
  expect(f.prepare).not.toHaveBeenCalled();
});
it("rejects retained terminals and rechecks immediately before detach", async () => {
  const f = fixture();
  f.deps.assertNoTerminals
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error("terminal");
    });
  await expect(reclaimManagedDependencies(input, f.deps)).rejects.toThrow("terminal");
  expect(f.commitSync).not.toHaveBeenCalled();
  expect(f.purge).not.toHaveBeenCalled();
  const leave = f.fence.enter();
  expect(leave).not.toBeNull();
  leave?.();
});
it("cannot overlap an existing renderer update", async () => {
  const f = fixture();
  const ticket = await f.quiescence.prepare({
    mode: "renderer",
    daemonIdentity: "daemon",
    candidateDigest: "d".repeat(64),
  });
  await expect(reclaimManagedDependencies(input, f.deps)).rejects.toThrow("already pending");
  expect(f.commitSync).not.toHaveBeenCalled();
  f.quiescence.abort(ticket);
});
it("does not detach when final lease is invalidated", async () => {
  const f = fixture();
  f.deps.assertNoTerminals.mockImplementationOnce(() => {
    f.fence.invalidate();
  });
  const original = f.quiescence.commit;
  f.quiescence.commit = async (ticket) => {
    const result = await original(ticket);
    f.fence.interrupt();
    return result;
  };
  await expect(reclaimManagedDependencies(input, f.deps)).rejects.toThrow("Stale");
  expect(f.commitSync).not.toHaveBeenCalled();
});
it("failed detach releases admission but never schedules purge", async () => {
  const f = fixture();
  f.commitSync.mockImplementation(() => {
    throw new Error("rolled back");
  });
  await expect(reclaimManagedDependencies(input, f.deps)).rejects.toThrow("rolled back");
  expect(f.purge).not.toHaveBeenCalled();
  const leave = f.fence.enter();
  expect(leave).not.toBeNull();
  leave?.();
});
it("reports asynchronous purge failure without misreporting detach failure", async () => {
  const f = fixture();
  f.purge.mockRejectedValue(new Error("disk busy"));
  expect((await reclaimManagedDependencies(input, f.deps)).detached).toBe(true);
  await Promise.resolve();
  expect(f.deps.onPurgeError).toHaveBeenCalled();
});

it("releases the setup lock if a competing update prevents lease acquisition", async () => {
  const f = fixture();
  const abortSync = vi.fn();
  f.prepare.mockResolvedValue({
    root: "/managed/worktree",
    commitSync: f.commitSync,
    purge: f.purge,
    abortSync,
  });
  const ticket = await f.quiescence.prepare({
    mode: "renderer",
    daemonIdentity: "daemon",
    candidateDigest: "d".repeat(64),
  });
  await expect(reclaimManagedDependencies(input, f.deps)).rejects.toThrow("already pending");
  expect(abortSync).toHaveBeenCalledTimes(1);
  expect(f.commitSync).not.toHaveBeenCalled();
  f.quiescence.abort(ticket);
});
