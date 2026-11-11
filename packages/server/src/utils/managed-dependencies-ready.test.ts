import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureManagedDependenciesReady } from "./managed-dependencies-ready.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "managed-resume-")));
  homes.push(root);
  const helper = join(root, "helper.mjs");
  await writeFile(helper, "// fixture");
  const receipt = (state?: string) =>
    writeFile(
      join(root, ".managed-dependencies.json"),
      JSON.stringify({ schemaVersion: 1, root, state }),
    );
  await receipt("retired");
  const env = { PASEO_WORKTREE_SETUP_HELPER: helper, PASEO_WORKTREE_DEPENDENCY_CONTEXT: "{}" };
  const runHelper = vi.fn(async () => {
    await receipt();
  });
  return { root, env, runHelper, receipt };
}
it("restores retired dependencies for nested cwd through the trusted helper only", async () => {
  const f = await fixture();
  const cwd = join(f.root, "packages", "app");
  await mkdir(cwd, { recursive: true });
  await ensureManagedDependenciesReady(cwd, f);
  expect(f.runHelper).toHaveBeenCalledWith(f.env.PASEO_WORKTREE_SETUP_HELPER, {
    ...f.env,
    PASEO_WORKTREE_PATH: f.root,
  });
  await ensureManagedDependenciesReady(cwd, f);
  expect(f.runHelper).toHaveBeenCalledTimes(1);
});
it("history reads never prepare dependencies", async () => {
  const f = await fixture();
  await ensureManagedDependenciesReady(f.root, { ...f, purpose: "history" });
  expect(f.runHelper).not.toHaveBeenCalled();
});
it("ordinary and nested unrelated repositories never inherit a parent receipt", async () => {
  const f = await fixture();
  const nested = join(f.root, "other");
  await mkdir(join(nested, ".git"), { recursive: true });
  await ensureManagedDependenciesReady(nested, f);
  expect(f.runHelper).not.toHaveBeenCalled();
});
it("missing trusted context blocks resume without installation fallback", async () => {
  const f = await fixture();
  await expect(ensureManagedDependenciesReady(f.root, { ...f, env: {} })).rejects.toThrow("donor");
  expect(f.runHelper).not.toHaveBeenCalled();
});
it("symbolic worktree aliases and receipt aliases are rejected", async () => {
  const f = await fixture();
  const alias = join(f.root, "alias");
  await symlink(f.root, alias);
  await expect(ensureManagedDependenciesReady(alias, f)).rejects.toThrow("aliases");
  await rm(join(f.root, ".managed-dependencies.json"));
  await symlink(f.env.PASEO_WORKTREE_SETUP_HELPER, join(f.root, ".managed-dependencies.json"));
  await expect(ensureManagedDependenciesReady(f.root, f)).rejects.toThrow("regular file");
  expect(f.runHelper).not.toHaveBeenCalled();
});
it("helper failure blocks launch and allows a later explicit retry", async () => {
  const f = await fixture();
  f.runHelper.mockRejectedValueOnce(new Error("donor unavailable"));
  await expect(ensureManagedDependenciesReady(f.root, f)).rejects.toThrow("donor unavailable");
  await ensureManagedDependenciesReady(f.root, f);
  expect(f.runHelper).toHaveBeenCalledTimes(2);
});
it("successful exit without prepared receipt still blocks launch", async () => {
  const f = await fixture();
  f.runHelper.mockImplementationOnce(async () => {});
  await expect(ensureManagedDependenciesReady(f.root, f)).rejects.toThrow("did not finish");
});
it("concurrent resume attempts share one helper", async () => {
  const f = await fixture();
  f.runHelper.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await f.receipt();
  });
  await Promise.all([
    ensureManagedDependenciesReady(f.root, f),
    ensureManagedDependenciesReady(f.root, f),
  ]);
  expect(f.runHelper).toHaveBeenCalledTimes(1);
});

it("partial retirement recovery state blocks execution", async () => {
  const f = await fixture();
  await f.receipt("retirement-recovery-required");
  await expect(ensureManagedDependenciesReady(f.root, f)).rejects.toThrow("recovery is required");
  expect(f.runHelper).not.toHaveBeenCalled();
});
