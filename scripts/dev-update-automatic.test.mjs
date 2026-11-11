import test from "node:test";
import assert from "node:assert/strict";
import { AutomaticUpdateController } from "./dev-update-automatic.mjs";

test("deadline crossing during authoritative commit never sends native commit", async () => {
  const f = fixture();
  await f.controller.advance(f.input);
  f.respond("prepared", { prepareToken: "token", activityEpoch: 2 });
  f.lease.commit = async () => {
    f.time(45000);
  };
  assert.equal((await f.controller.advance(f.input)).reason, "handoff-deadline");
  assert.deepEqual(f.calls, ["prepare", "abort", "release"]);
});

function fixture() {
  let now = 0,
    receipt,
    failure;
  const calls = [];
  const instance = {
    pid: 1,
    startedAt: "today",
    uid: 501,
    hostname: "lab",
    serverId: "test",
    desktopManaged: true,
    listen: "local",
  };
  const lease = {
    identity: { token: "lease" },
    check: async () => true,
    commit: async () => {
      calls.push("commit");
    },
    release: async () => {
      calls.push("release");
    },
    failure: new Promise((resolve) => {
      failure = resolve;
    }),
  };
  const runtime = {
    generation: "generation",
    requestAutomaticHandoff: async (r) => {
      calls.push(r.phase);
    },
    automaticHandoffResult: async () => receipt,
  };
  const input = {
    runtime,
    instance,
    pending: { digest: "a".repeat(64) },
    mode: "renderer",
  };
  const controller = new AutomaticUpdateController({
    now: () => now,
    createLease: async () => lease,
    requestId: () => "request",
  });
  const respond = (state, extra = {}) => {
    receipt = {
      ...controller.current.request,
      generation: runtime.generation,
      state,
      ...extra,
    };
    return receipt;
  };
  return {
    controller,
    input,
    runtime,
    lease,
    calls,
    respond,
    fail: failure,
    time: (v) => {
      now = v;
    },
  };
}

test("prepared -> lease commit -> exact native commit; hold lease through relaunch", async () => {
  const f = fixture();
  assert.equal((await f.controller.advance(f.input)).state, "preparing");
  f.respond("prepared", { prepareToken: "token", activityEpoch: 4 });
  assert.equal((await f.controller.advance(f.input)).state, "committing");
  assert.deepEqual(f.calls, ["prepare", "commit", "commit"]);
  const receipt = f.respond("ready");
  assert.equal(await f.controller.validateExit({ receipt, instance: f.input.instance }), true);
  assert.equal(f.calls.includes("release"), false);
  f.time(100000);
  assert.equal(await f.controller.assertHeld(), true);
  await f.controller.complete();
  assert.equal(f.calls.at(-1), "release");
});

test("relaunch lease failure blocks assertHeld and complete", async () => {
  const f = fixture();
  await f.controller.advance(f.input);
  f.respond("prepared", { prepareToken: "token", activityEpoch: 4 });
  await f.controller.advance(f.input);
  await f.controller.validateExit({
    receipt: f.respond("ready"),
    instance: f.input.instance,
  });
  f.fail({ failure: "expired" });
  await Promise.resolve();
  await assert.rejects(f.controller.assertHeld(), /expired/);
  await assert.rejects(f.controller.complete(), /expired/);
  assert.equal(f.calls.includes("release"), false);
});

test("missing capability and full updates never create handoff", async () => {
  const f = fixture();
  assert.equal((await f.controller.advance({ ...f.input, mode: "full" })).state, "unsupported");
  assert.equal((await f.controller.advance({ ...f.input, runtime: {} })).state, "unsupported");
  assert.deepEqual(f.calls, []);
});

test("stale generation ignored; malformed prepare aborts", async () => {
  const f = fixture();
  await f.controller.advance(f.input);
  f.respond("prepared", {
    generation: "old",
    prepareToken: "t",
    activityEpoch: 1,
  });
  assert.equal((await f.controller.advance(f.input)).state, "preparing");
  f.respond("prepared", { prepareToken: "t", activityEpoch: NaN });
  assert.equal((await f.controller.advance(f.input)).reason, "invalid-prepare-receipt");
  assert.deepEqual(f.calls.slice(-2), ["abort", "release"]);
});

test("explicit cancel suppresses digest and returns durable suppression signal", async () => {
  const f = fixture();
  await f.controller.advance(f.input);
  f.respond("blocked", { blockers: ["cancelled"] });
  assert.equal((await f.controller.advance(f.input)).suppressDigest, f.input.pending.digest);
  f.time(100000);
  assert.equal((await f.controller.advance(f.input)).state, "suppressed");
});

for (const reason of ["input", "quit-vetoed"])
  test(`${reason} aborts without forcing quit and cools down`, async () => {
    const f = fixture();
    await f.controller.advance(f.input);
    f.respond("blocked", { blockers: [reason] });
    assert.equal((await f.controller.advance(f.input)).reason, reason);
    assert.equal((await f.controller.advance(f.input)).state, "cooldown");
  });

test("expiry, renewed lease failure, and selection change release admissions", async () => {
  for (const condition of ["time", "failure", "selection"]) {
    const f = fixture();
    await f.controller.advance(f.input);
    if (condition === "time") f.time(45000);
    if (condition === "failure") {
      f.fail({ failure: "lease-expired" });
      await Promise.resolve();
    }
    if (condition === "selection") f.input.pending = { digest: "b".repeat(64) };
    assert.equal((await f.controller.advance(f.input)).state, "blocked");
    assert.equal(f.calls.at(-1), "release");
  }
});

test("user quit without ready or changed retained daemon cannot authorize cutover", async () => {
  for (const ready of [false, true]) {
    const f = fixture();
    await f.controller.advance(f.input);
    let receipt;
    if (ready) {
      f.respond("prepared", { prepareToken: "token", activityEpoch: 2 });
      await f.controller.advance(f.input);
      receipt = f.respond("ready");
    }
    assert.equal(
      await f.controller.validateExit({
        receipt,
        instance: { ...f.input.instance, ...(ready ? { pid: 2 } : {}) },
      }),
      false,
    );
    assert.equal(f.calls.at(-1), "release");
  }
});

test("mismatched ready token fails closed and concurrent ticks create only one lease", async () => {
  const f = fixture();
  await Promise.all([f.controller.advance(f.input), f.controller.advance(f.input)]);
  assert.equal(f.calls.filter((v) => v === "prepare").length, 1);
  f.respond("prepared", { prepareToken: "token", activityEpoch: 2 });
  await f.controller.advance(f.input);
  f.respond("ready", { prepareToken: "other" });
  assert.equal((await f.controller.advance(f.input)).reason, "invalid-ready-receipt");
});
