import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createShutdownQuiescenceTracker } from "./shutdown-quiescence.ts";
test("stop returning successfully is not proof of complete writer quiescence", () => {
  const tracker = createShutdownQuiescenceTracker();
  assert.equal(tracker.snapshot().state, "not-started");
  tracker.begin();
  assert.equal(tracker.snapshot().state, "stopping");
  tracker.finish(true);
  assert.equal(tracker.snapshot().state, "returned");
  assert.equal(tracker.snapshot().quiescent, false);
  assert.ok(tracker.snapshot().unverified.includes("registry-and-session-writer-coverage"));
});
test("swallowed failures remain visible, deduplicated and snapshots isolated", () => {
  const tracker = createShutdownQuiescenceTracker();
  tracker.begin();
  tracker.failure("agent-storage-flush");
  tracker.failure("agent-storage-flush");
  tracker.finish(false);
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.failures, ["agent-storage-flush"]);
  snapshot.failures.length = 0;
  assert.deepEqual(tracker.snapshot().failures, ["agent-storage-flush"]);
  assert.equal(tracker.snapshot().state, "failed");
});
test("real stop captures formerly swallowed errors without releasing activation lease", () => {
  const source = fs.readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
  for (const component of [
    "agent-manager-flush",
    "agent-storage-flush",
    "schedule-stop",
    "relay-stop",
    "plugin-lifecycle-events",
  ])
    assert.ok(source.includes(`shutdownQuiescence.failure("${component}")`));
  assert.ok(source.includes("getShutdownQuiescence: () => shutdownQuiescence.snapshot()"));
  assert.ok(!source.includes("activationLease.release"));
});
