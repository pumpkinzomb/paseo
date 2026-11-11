import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  reclaimManagedDependencies,
  type PrepareManagedDetach,
} from "./managed-dependency-maintenance.js";
import { createUpdateQuiescence, UpdateAdmissionFence } from "./update-quiescence.js";

const scripts = new URL("../../../../scripts/", import.meta.url);
// Import the exact sealed-launcher helpers without copying their filesystem logic into tests.
const fixtureModule = await import(new URL("managed-worktree-test-fixture.mjs", scripts).href);
const retirementModule = await import(new URL("managed-worktree-retirement.mjs", scripts).href);
const preparationModule = await import(new URL("prepare-managed-worktree.mjs", scripts).href);
const dependenciesModule = await import(new URL("dev-update-dependencies.mjs", scripts).href);

it("real registered artifacts detach through daemon fence, purge, then restore by verified CoW reuse", async () => {
  const f = await fixtureModule.managedDependencyFixture(
    { after: afterEach },
    { fileCount: 3, nested: true },
  );
  const fence = new UpdateAdmissionFence();
  const quiescence = createUpdateQuiescence({
    identity: () => "fixture-daemon",
    fence,
    runtimes: () => [],
    missingIngressCoverage: () => [],
    blockers: () => [],
    stop: async () => {
      throw new Error("must not stop daemon");
    },
  });
  afterEach(() => quiescence.dispose());
  let purgeCompletion: Promise<unknown> | undefined;
  const prepare: PrepareManagedDetach = async (...args) => {
    const actual = await retirementModule.prepareManagedDetach(...args);
    return {
      ...actual,
      purge: () => {
        purgeCompletion = actual.purge();
        return purgeCompletion!;
      },
    };
  };
  const onPurgeError = vi.fn();
  const result = await reclaimManagedDependencies(
    {
      daemonIdentity: "fixture-daemon",
      registryId: f.id,
      evidence: f.evidence,
    },
    {
      daemonIdentity: "fixture-daemon",
      registry: f.registry,
      prepare,
      quiescence,
      assertNoTerminals: () => {},
      onPurgeError,
    },
  );
  expect(result.detached).toBe(true);
  expect(result.purgePending).toBe(true);
  await expect(fs.stat(path.join(f.root, "node_modules"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const retiredReceipt = JSON.parse(
    await fs.readFile(path.join(f.root, ".managed-dependencies.json"), "utf8"),
  );
  expect(retiredReceipt.state).toBe("retired");
  expect(await fs.readFile(path.join(f.root, "history"), "utf8")).toBe("conversation");
  expect(((await purgeCompletion) as { state: string }).state).toBe("purged");
  expect(onPurgeError).not.toHaveBeenCalled();
  const restored = await preparationModule.prepareManagedWorktree(
    {
      PASEO_WORKTREE_PATH: f.root,
      PASEO_WORKTREE_DEPENDENCY_CONTEXT: JSON.stringify(f.context),
    },
    {
      prepare: (options: Record<string, unknown>) =>
        dependenciesModule.prepareDependencies({
          ...options,
          // Tiny disposable fixture only; production retains the 8 GiB reserve.
          minFreeBytes: 0,
        }),
    },
  );
  expect(restored.mode).toBe("reuse");
  const restoredReceipt = JSON.parse(
    await fs.readFile(path.join(f.root, ".managed-dependencies.json"), "utf8"),
  );
  expect(restoredReceipt.state).not.toBe("retired");
  for (const name of Object.keys(f.receipt.entries)) {
    const source = path.join(f.context.releases, f.context.donor.id, name);
    const destination = path.join(f.root, name);
    expect(await fs.readFile(destination)).toEqual(await fs.readFile(source));
    expect((await fs.stat(destination)).ino).not.toBe((await fs.stat(source)).ino);
  }
  expect(await fs.readFile(path.join(f.root, "history"), "utf8")).toBe("conversation");
});
