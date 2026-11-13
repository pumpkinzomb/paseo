import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createWorkDrain } from "./work-drain.ts";
test("close rejects ingress and waits for admitted writes", async () => {
  const drain = createWorkDrain();
  let release;
  let written = false;
  const gate = new Promise((r) => {
    release = r;
  });
  const write = drain.run(async () => {
    await gate;
    written = true;
  });
  let closed = false;
  const closing = drain.close().then(() => {
    closed = true;
    return undefined;
  });
  await assert.rejects(
    drain.run(async () => {}),
    /closed/,
  );
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await write;
  await closing;
  assert.equal(written, true);
});
test("drain waits all work even when one fails and reports the failure", async () => {
  const drain = createWorkDrain();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const bad = drain.run(async () => {
    throw new Error("write failed");
  });
  const good = drain.run(async () => gate);
  const rejected = assert.rejects(bad, /write failed/);
  const closing = assert.rejects(drain.close(), AggregateError);
  release();
  await good;
  await rejected;
  await closing;
});
test("actual reconciliation close is awaited before later teardown", () => {
  const source = fs.readFileSync(
    new URL("./workspace-reconciliation-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /async close\(\): Promise<void> \{\s*this.dispose\(\);\s*await this.workDrain.close\(\)/,
  );
  for (const name of ["start", "runOnce", "reconcileGitMetadata", "reconcileObservedGitMetadata"])
    assert.ok(source.includes(`this.workDrain.run(() => this.${name}Internal(`));
  const bootstrap = fs.readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
  assert.ok(bootstrap.includes("await workspaceReconciliation.close();"));
});
