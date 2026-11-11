import { randomUUID } from "node:crypto";
import type { RuntimeCleanupCandidate } from "./agent/idle-runtime-cleanup/index.js";

/** A local-only primitive, deliberately NOT registered on the session protocol.
 * Wiring a transport is unsafe until every admission source uses this fence.
 */
export interface UpdateBinding {
  mode: "renderer" | "daemon";
  daemonIdentity: string;
  candidateDigest: string;
}
export interface UpdateTicket extends UpdateBinding {
  token: string;
  expiresAt: number;
  epoch: number;
}
export class UpdateBlocked extends Error {}

/** Callers must retain/retry durable deliveries when admission returns null. */
export class UpdateAdmissionFence {
  private fenced = false;
  private active = 0;
  private revision = 0;
  get epoch(): number {
    return this.revision;
  }
  invalidate(): void {
    this.revision++;
  }
  interrupt(): void {
    this.invalidate();
    this.open();
  }
  assertOpen(): void {
    if (this.fenced) throw new UpdateBlocked("update_in_progress");
  }
  enter(): (() => void) | null {
    if (this.fenced) return null;
    this.active++;
    this.revision++;
    let released = false;
    return () => {
      if (!released) this.active--;
      released = true;
    };
  }
  get pending(): number {
    return this.active;
  }
  close(): void {
    this.fenced = true;
  }
  open(): void {
    this.fenced = false;
  }
}

export interface UpdateQuiescenceOptions {
  identity(): string;
  fence: UpdateAdmissionFence;
  /** Must include all live runtimes, including internal/provider subagents. */
  runtimes(): readonly RuntimeCleanupCandidate[];
  /** Nonempty until every ingress is reversibly fenced and preserves rejected work. */
  missingIngressCoverage(): readonly string[];
  /** Read-only checks for approvals, lifecycle/event tails and durable deliveries. */
  blockers(): readonly string[];
  /** Supported graceful lifecycle stop only. Never signal or force-kill. */
  stop(options: { keepTerminals: true }): Promise<void>;
  ttlMs?: number;
}

export function createUpdateQuiescence(options: UpdateQuiescenceOptions) {
  const ttl = options.ttlMs ?? 15_000;
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 60_000) throw new Error("Invalid lease TTL");
  let lease: UpdateTicket | null = null;
  let phase: "preparing" | "ready" | "held" | "committing" | null = null;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function release() {
    clearTimeout(timer);
    lease = null;
    phase = null;
    options.fence.open();
  }
  function validate(ticket: UpdateTicket, allowInvalidated = false) {
    if (
      !lease ||
      ticket.token !== lease.token ||
      ticket.mode !== lease.mode ||
      ticket.epoch !== lease.epoch ||
      (!allowInvalidated && options.fence.epoch !== lease.epoch) ||
      ticket.daemonIdentity !== lease.daemonIdentity ||
      ticket.candidateDigest !== lease.candidateDigest ||
      ticket.expiresAt !== lease.expiresAt ||
      options.identity() !== lease.daemonIdentity ||
      Date.now() >= lease.expiresAt
    ) {
      throw new UpdateBlocked("Stale or mismatched update lease");
    }
  }
  function check() {
    const missing = options.missingIngressCoverage();
    const blockers = options.blockers();
    if (missing.length || blockers.length || options.fence.pending) {
      throw new UpdateBlocked(
        `Update not quiescent: ${[
          ...missing,
          ...blockers,
          ...(options.fence.pending ? ["admitted work pending"] : []),
        ].join(", ")}`,
      );
    }
  }
  async function probe(ticket: UpdateTicket) {
    validate(ticket);
    check();
    const before = options.runtimes();
    for (const runtime of before) {
      if (!runtime.sessionId || !runtime.isEligible() || !runtime.canStopRuntime) {
        throw new UpdateBlocked(`Runtime safety unknown: ${runtime.agentId}`);
      }
      // Expiry revokes the fence even when a provider probe never resolves.
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      const allowed = await Promise.race([
        runtime.canStopRuntime(),
        new Promise<never>((_, reject) => {
          probeTimer = setTimeout(
            () => reject(new UpdateBlocked("Provider probe timed out")),
            Math.max(0, ticket.expiresAt - Date.now()),
          );
          probeTimer.unref();
        }),
      ]).finally(() => clearTimeout(probeTimer));
      validate(ticket);
      if (!allowed || !runtime.isEligible())
        throw new UpdateBlocked(`Runtime veto: ${runtime.agentId}`);
    }
    check();
    validate(ticket);
    const after = options.runtimes();
    if (
      after.length !== before.length ||
      before.some(
        (runtime) =>
          !runtime.isEligible() ||
          !after.some(
            (next) => next.identity === runtime.identity && next.agentId === runtime.agentId,
          ),
      )
    ) {
      throw new UpdateBlocked("Runtime set changed during probe");
    }
  }
  return {
    dispose() {
      release();
    },
    async prepare(binding: UpdateBinding): Promise<UpdateTicket> {
      if (lease) throw new UpdateBlocked("Update already pending");
      if (
        !["renderer", "daemon"].includes(binding.mode) ||
        binding.daemonIdentity !== options.identity() ||
        !/^[a-f0-9]{64}$/.test(binding.candidateDigest)
      ) {
        throw new UpdateBlocked("Invalid update binding");
      }
      startedAt = Date.now();
      const ticket = {
        ...binding,
        token: randomUUID(),
        epoch: options.fence.epoch,
        expiresAt: Date.now() + ttl,
      };
      lease = ticket;
      phase = "preparing";
      options.fence.close();
      timer = setTimeout(release, ttl);
      timer.unref();
      try {
        await probe(ticket);
        phase = "ready";
        return { ...ticket };
      } catch (error) {
        if (lease === ticket) release();
        throw error;
      }
    },
    inspect(ticket: UpdateTicket) {
      validate(ticket);
      check();
      return { ...lease!, phase };
    },
    renew(ticket: UpdateTicket) {
      validate(ticket);
      check();
      if (phase !== "ready" && phase !== "held") throw new UpdateBlocked("Lease not renewable");
      const expiresAt = Math.min(Date.now() + ttl, startedAt + 600_000);
      if (expiresAt <= Date.now()) throw new UpdateBlocked("Maximum lease duration reached");
      lease = { ...lease!, expiresAt };
      clearTimeout(timer);
      timer = setTimeout(release, expiresAt - Date.now());
      timer.unref();
      return { ...lease };
    },
    /** Final same-event-loop boundary for short synchronous filesystem detach only.
     * Never pass async work here: admission may reopen immediately after return.
     */
    runSynchronousMaintenance<T>(ticket: UpdateTicket, operation: () => T): T {
      validate(ticket);
      check();
      if (ticket.mode !== "renderer" || phase !== "held")
        throw new UpdateBlocked("Maintenance requires a held renderer lease");
      if (options.runtimes().length)
        throw new UpdateBlocked("Maintenance requires no resident agent runtimes");
      return operation();
    },
    abort(ticket: UpdateTicket) {
      validate(ticket, true);
      if (phase === "committing") throw new UpdateBlocked("Commit outcome must be reconciled");
      release();
    },
    async commit(ticket: UpdateTicket) {
      validate(ticket);
      if (phase !== "ready") throw new UpdateBlocked("Lease not ready");
      phase = "preparing";
      try {
        await probe(ticket);
      } catch (error) {
        if (lease?.token === ticket.token) release();
        throw error;
      }
      if (ticket.mode === "renderer") {
        phase = "held";
        return { ...lease! };
      }
      phase = "committing";
      clearTimeout(timer);
      // From this point an error is an uncertain stop, not permission to admit work.
      await options.stop({ keepTerminals: true });
    },
  };
}
