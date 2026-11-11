import { afterEach, expect, it, vi } from "vitest";
import { createUpdateQuiescence, UpdateAdmissionFence } from "./update-quiescence.js";
import type { RuntimeCleanupCandidate } from "./agent/idle-runtime-cleanup/index.js";
const binding = {
  mode: "daemon" as const,
  daemonIdentity: "pid:42:started:123:server:abc",
  candidateDigest: "a".repeat(64),
};
function fixture() {
  const fence = new UpdateAdmissionFence();
  const runtime: RuntimeCleanupCandidate = {
    identity: {},
    agentId: "agent",
    parentAgentId: undefined,
    provider: "fixture",
    sessionId: "session",
    lastActivityAt: 0,
    isEligible: () => true,
    canStopRuntime: vi.fn(async () => true),
    closeIfEligible: vi.fn(async () => true),
  };
  const options = {
    identity: () => binding.daemonIdentity,
    fence,
    runtimes: () => [runtime],
    missingIngressCoverage: () => [] as string[],
    blockers: () => [] as string[],
    stop: vi.fn(async () => {}),
    ttlMs: 100,
  };
  return { fence, runtime, options, lease: createUpdateQuiescence(options) };
}
afterEach(() => vi.useRealTimers());
it("fences admission and abort restores it without dropping admitted work", async () => {
  const f = fixture();
  const leave = f.fence.enter()!;
  await expect(f.lease.prepare(binding)).rejects.toThrow("admitted work pending");
  expect(f.fence.pending).toBe(1);
  leave();
  leave();
  const ticket = await f.lease.prepare(binding);
  expect(f.fence.enter()).toBeNull();
  f.lease.abort(ticket);
  expect(f.fence.enter()).not.toBeNull();
  expect(f.options.stop).not.toHaveBeenCalled();
});
it("expires a ready lease and rejects stale commit", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const ticket = await f.lease.prepare(binding);
  await vi.advanceTimersByTimeAsync(101);
  expect(f.fence.enter()).not.toBeNull();
  await expect(f.lease.commit(ticket)).rejects.toThrow("Stale");
});
it("blocks uncovered ingress, unknown safety, pending approvals and provider veto", async () => {
  for (const kind of ["coverage", "approval", "unknown", "veto"]) {
    const f = fixture();
    if (kind === "coverage") f.options.missingIngressCoverage = () => ["scheduler"];
    if (kind === "approval") f.options.blockers = () => ["pending approval"];
    if (kind === "unknown") f.runtime.canStopRuntime = undefined;
    if (kind === "veto") f.runtime.canStopRuntime = async () => false;
    await expect(f.lease.prepare(binding)).rejects.toThrow();
    expect(f.fence.enter()).not.toBeNull();
    expect(f.options.stop).not.toHaveBeenCalled();
  }
});
it("revalidates runtime races and rechecks provider veto at commit", async () => {
  const f = fixture();
  const ticket = await f.lease.prepare(binding);
  f.runtime.canStopRuntime = async () => {
    f.runtime.isEligible = () => false;
    return true;
  };
  await expect(f.lease.commit(ticket)).rejects.toThrow("Runtime veto");
  expect(f.options.stop).not.toHaveBeenCalled();
  expect(f.fence.enter()).not.toBeNull();
});
it("requires exact ticket and commits only terminal-preserving stop", async () => {
  const f = fixture();
  const ticket = await f.lease.prepare(binding);
  await expect(f.lease.commit({ ...ticket, candidateDigest: "b".repeat(64) })).rejects.toThrow();
  await expect(f.lease.commit({ ...ticket, token: "wrong" })).rejects.toThrow();
  await f.lease.commit(ticket);
  expect(f.options.stop).toHaveBeenCalledWith({ keepTerminals: true });
  expect(f.fence.enter()).toBeNull();
  expect(f.runtime.closeIfEligible).not.toHaveBeenCalled();
});
it("times out a hanging provider and reopens admission", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.runtime.canStopRuntime = () => new Promise(() => {});
  const pending = expect(f.lease.prepare(binding)).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(101);
  await pending;
  expect(f.fence.enter()).not.toBeNull();
});
it("does not release the fence on uncertain stop failure", async () => {
  const f = fixture();
  const ticket = await f.lease.prepare(binding);
  f.options.stop.mockRejectedValueOnce(new Error("lost acknowledgment"));
  await expect(f.lease.commit(ticket)).rejects.toThrow("lost acknowledgment");
  expect(f.fence.enter()).toBeNull();
  expect(() => f.lease.abort(ticket)).toThrow("reconciled");
});
it("rejects daemon replacement and runtime membership changes", async () => {
  const f = fixture();
  const ticket = await f.lease.prepare(binding);
  f.options.identity = () => "replacement";
  await expect(f.lease.commit(ticket)).rejects.toThrow("Stale");
  expect(f.options.stop).not.toHaveBeenCalled();
  const g = fixture();
  g.runtime.canStopRuntime = async () => {
    g.options.runtimes = () => [];
    return true;
  };
  await expect(g.lease.prepare(binding)).rejects.toThrow("Runtime set changed");
  expect(g.fence.enter()).not.toBeNull();
});
it("rejects simultaneous prepares and double commits", async () => {
  const f = fixture();
  const ticket = await f.lease.prepare(binding);
  await expect(f.lease.prepare(binding)).rejects.toThrow("already pending");
  await f.lease.commit(ticket);
  await expect(f.lease.commit(ticket)).rejects.toThrow("not ready");
  expect(f.options.stop).toHaveBeenCalledTimes(1);
});
it("renderer commit holds the fence, renews within a bound, and abort releases without stop", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let ticket = await f.lease.prepare({ ...binding, mode: "renderer" });
  await f.lease.commit(ticket);
  expect(f.fence.enter()).toBeNull();
  await vi.advanceTimersByTimeAsync(50);
  ticket = f.lease.renew(ticket);
  expect(f.lease.inspect(ticket).phase).toBe("held");
  await vi.advanceTimersByTimeAsync(51);
  expect(f.fence.enter()).toBeNull();
  f.lease.abort(ticket);
  expect(f.fence.enter()).not.toBeNull();
  expect(f.options.stop).not.toHaveBeenCalled();
});
it("external event invalidation prevents commit and renewal but allows safe abort", async () => {
  const f = fixture();
  const ticket = await f.lease.prepare({ ...binding, mode: "renderer" });
  f.fence.invalidate();
  expect(() => f.lease.inspect(ticket)).toThrow("Stale");
  expect(() => f.lease.renew(ticket)).toThrow("Stale");
  await expect(f.lease.commit(ticket)).rejects.toThrow("Stale");
  f.lease.abort(ticket);
  expect(f.fence.enter()).not.toBeNull();
});
