import { randomUUID } from "node:crypto";

const identityKeys = [
  "pid",
  "startedAt",
  "uid",
  "hostname",
  "serverId",
  "desktopManaged",
  "listen",
];
const sameInstance = (a, b) =>
  Boolean(a && b && identityKeys.every((key) => a[key] !== undefined && a[key] === b[key]));
const digestOf = (pending) => pending?.digest ?? pending?.release?.digest;
const validEpoch = (value) => Number.isSafeInteger(value) && value >= 0;

/** Pure orchestration. The runtime owns private files and normal quit; the lease
 * owns renewal/admission. Neither a timeout nor a failed checkpoint forces exit. */
export class AutomaticUpdateController {
  constructor({
    createLease,
    now = Date.now,
    deadlineMs = 45000,
    cooldownMs = 60000,
    requestId = randomUUID,
  } = {}) {
    Object.assign(this, {
      createLease,
      now,
      deadlineMs,
      cooldownMs,
      requestId,
    });
    this.current = null;
    this.cooldownUntil = 0;
    this.suppressed = new Set();
    this.tail = Promise.resolve();
  }

  serialize(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  advance(input) {
    return this.serialize(() => this.advanceUnlocked(input));
  }

  async abortUnlocked(reason) {
    const current = this.current;
    this.current = null;
    if (!current) return { state: "idle" };
    const cancelled = reason === "cancelled";
    if (cancelled) this.suppressed.add(current.request.releaseDigest);
    this.cooldownUntil = this.now() + this.cooldownMs;
    let cleanupError;
    try {
      await current.runtime.requestAutomaticHandoff({
        ...current.request,
        phase: "abort",
      });
    } catch (error) {
      cleanupError = String(error);
    }
    try {
      await current.lease.release();
    } catch (error) {
      cleanupError = String(error);
    }
    return {
      state: "blocked",
      reason,
      ...(cancelled ? { suppressDigest: current.request.releaseDigest } : {}),
      ...(cleanupError ? { cleanupError } : {}),
    };
  }

  abort(reason = "controller-aborted") {
    return this.serialize(() => this.abortUnlocked(reason));
  }

  matches(receipt, current, phase) {
    return (
      receipt?.schemaVersion === 2 &&
      receipt.generation === current.generation &&
      receipt.requestId === current.request.requestId &&
      receipt.releaseDigest === current.request.releaseDigest &&
      receipt.mode === "renderer" &&
      receipt.phase === phase
    );
  }

  selectionChanged(current, { runtime, digest, instance, mode }) {
    return (
      runtime !== current.runtime ||
      runtime.generation !== current.generation ||
      digest !== current.request.releaseDigest ||
      mode !== "renderer" ||
      !sameInstance(instance, current.instance)
    );
  }

  async startUnlocked({ runtime, pending, instance, mode, digest }) {
    if (!pending) return { state: "idle" };
    if (mode !== "renderer")
      return { state: "unsupported", reason: "full-update-lease-unsupported" };
    if (
      !this.createLease ||
      !runtime?.generation ||
      typeof runtime.requestAutomaticHandoff !== "function" ||
      typeof runtime.automaticHandoffResult !== "function"
    )
      return { state: "unsupported", reason: "automatic-capability-unavailable" };
    if (!/^[a-f0-9]{64}$/.test(digest ?? "") || !sameInstance(instance, instance))
      return { state: "blocked", reason: "invalid-selection-or-instance" };
    if (this.suppressed.has(digest)) return { state: "suppressed", suppressDigest: digest };
    if (this.now() < this.cooldownUntil) return { state: "cooldown", retryAt: this.cooldownUntil };
    let lease;
    try {
      lease = await this.createLease({ instance, candidateDigest: digest, mode });
    } catch (error) {
      this.cooldownUntil = this.now() + this.cooldownMs;
      return { state: "blocked", reason: String(error), retryAt: this.cooldownUntil };
    }
    if (
      !lease ||
      !lease.identity ||
      !["check", "commit", "release"].every((key) => typeof lease[key] === "function")
    ) {
      await lease?.release?.();
      return { state: "unsupported", reason: "authoritative-lease-unavailable" };
    }
    return this.prepareUnlocked({ runtime, instance, mode, digest, lease });
  }

  async prepareUnlocked({ runtime, instance, mode, digest, lease }) {
    const current = {
      runtime,
      generation: runtime.generation,
      instance: { ...instance },
      lease,
      deadline: this.now() + this.deadlineMs,
      state: "preparing",
      request: {
        schemaVersion: 2,
        requestId: this.requestId(),
        releaseDigest: digest,
        mode,
        phase: "prepare",
      },
    };
    this.current = current;
    if (lease.failure)
      Promise.resolve(lease.failure).then(
        (failure) => (current.failure = failure?.failure ?? "lease-failed"),
        (error) => (current.failure = String(error)),
      );
    try {
      if ((await lease.check()) === false) return this.abortUnlocked("lease-invalid");
      if (current.failure || this.now() >= current.deadline)
        return this.abortUnlocked("lease-or-deadline-expired");
      await runtime.requestAutomaticHandoff(current.request);
    } catch (error) {
      return this.abortUnlocked(String(error));
    }
    return { state: "preparing" };
  }

  async commitPreparedUnlocked(current, receipt) {
    if (
      typeof receipt.prepareToken !== "string" ||
      !receipt.prepareToken ||
      !validEpoch(receipt.activityEpoch)
    )
      return this.abortUnlocked("invalid-prepare-receipt");
    if ((await current.lease.commit()) === false || current.failure)
      return this.abortUnlocked("lease-commit-failed");
    if (this.now() >= current.deadline) return this.abortUnlocked("handoff-deadline");
    current.request = {
      ...current.request,
      phase: "commit",
      prepareToken: receipt.prepareToken,
      activityEpoch: receipt.activityEpoch,
    };
    current.state = "committing";
    await current.runtime.requestAutomaticHandoff(current.request);
    return { state: current.state };
  }

  async consumeReceiptUnlocked(current, receipt) {
    if (!receipt) return { state: current.state };
    if (!this.matches(receipt, current, current.request.phase))
      return { state: current.state, reason: "stale-receipt-ignored" };
    if (receipt.state === "blocked" || receipt.state === "cancelled") {
      const blockers = receipt.blockers ?? [];
      return this.abortUnlocked(
        receipt.state === "cancelled" || blockers.includes("cancelled")
          ? "cancelled"
          : blockers.join(",") || "native-blocked",
      );
    }
    if (current.state === "preparing" && receipt.state === "prepared") {
      return this.commitPreparedUnlocked(current, receipt);
    } else if (receipt.state === "ready" && current.request.phase === "commit") {
      if (
        receipt.prepareToken !== current.request.prepareToken ||
        receipt.activityEpoch !== current.request.activityEpoch
      )
        return this.abortUnlocked("invalid-ready-receipt");
      current.receipt = receipt;
      current.state = "ready";
    }
    return { state: current.state };
  }

  async advanceUnlocked({ runtime, pending, instance, mode }) {
    const digest = digestOf(pending);
    const current = this.current;
    if (current && this.selectionChanged(current, { runtime, digest, instance, mode }))
      return this.abortUnlocked("selection-or-instance-changed");
    if (!current) return this.startUnlocked({ runtime, pending, instance, mode, digest });
    if (current.failure) return this.abortUnlocked(current.failure);
    if (this.now() >= current.deadline) return this.abortUnlocked("handoff-deadline");
    try {
      if ((await current.lease.check()) === false) return this.abortUnlocked("lease-invalid");
      const receipt = await runtime.automaticHandoffResult(current.request.requestId, digest);
      if (current.failure || this.now() >= current.deadline)
        return this.abortUnlocked("lease-or-deadline-expired");
      return await this.consumeReceiptUnlocked(current, receipt);
    } catch (error) {
      return this.abortUnlocked(String(error));
    }
  }

  validateExit({ receipt, instance }) {
    return this.serialize(async () => {
      const current = this.current;
      const value = receipt ?? current?.receipt;
      if (
        !current ||
        current.failure ||
        this.now() >= current.deadline ||
        !sameInstance(instance, current.instance) ||
        !this.matches(value, current, "commit") ||
        value.state !== "ready" ||
        value.prepareToken !== current.request.prepareToken ||
        !validEpoch(value.activityEpoch) ||
        value.activityEpoch !== current.request.activityEpoch
      ) {
        await this.abortUnlocked("exit-without-valid-ready");
        return false;
      }
      try {
        if ((await current.lease.check()) === false) throw new Error("lease-invalid");
        if (current.failure || this.now() >= current.deadline)
          throw new Error("lease-or-deadline-expired");
        current.state = "relaunching";
        return true;
      } catch (error) {
        await this.abortUnlocked(String(error));
        return false;
      }
    });
  }

  /** Call only after replacement runtime readiness and retained-daemon verification. */
  async assertHeldUnlocked() {
    const current = this.current;
    if (!current || current.state !== "relaunching" || current.failure)
      throw new Error(current?.failure ?? "No validated automatic exit");
    if ((await current.lease.check()) === false || current.failure)
      throw new Error(current.failure ?? "lease-invalid");
    return true;
  }

  assertHeld() {
    return this.serialize(() => this.assertHeldUnlocked());
  }

  complete() {
    return this.serialize(async () => {
      const current = this.current;
      await this.assertHeldUnlocked();
      await current.lease.release();
      this.current = null;
      return { state: "complete" };
    });
  }
}
