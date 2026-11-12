import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isolateDevelopmentTask,
  developmentTaskPrompt,
  type TaskWorkspace,
} from "./development-task.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function source(git = true): Promise<TaskWorkspace> {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-task-isolation-"));
  roots.push(cwd);
  if (git) await mkdir(join(cwd, ".git"));
  return { cwd, workspaceId: "parent" };
}
test("parallel Git children receive unique branches without modifying their source", async () => {
  const parent = await source();
  await writeFile(join(parent.cwd, "unfinished.txt"), "parent work");
  const create = async (_source: TaskWorkspace, slug: string) => ({
    cwd: join(parent.cwd, slug),
    workspaceId: slug,
    branchName: slug,
  });
  const children = await Promise.all(
    [1, 2].map(() => isolateDevelopmentTask({ source: parent, isSubagent: true }, create)),
  );
  expect(children[0]?.cwd).not.toBe(children[1]?.cwd);
  expect(children[0]?.workspaceId).not.toBe(parent.workspaceId);
  expect(children[0]?.branchName).toMatch(/^task-/);
});
test("read-only and top-level conversations do not provision worktrees", async () => {
  const parent = await source();
  const unexpected = async (): Promise<TaskWorkspace> => {
    throw new Error("must not provision");
  };
  expect(
    await isolateDevelopmentTask(
      { source: parent, isSubagent: true, taskKind: "read-only" },
      unexpected,
    ),
  ).toBe(null);
  expect(await isolateDevelopmentTask({ source: parent, isSubagent: false }, unexpected)).toBe(
    null,
  );
});
test("non-Git conversation stays shared but explicit development requires a project", async () => {
  const parent = await source(false);
  const unexpected = async (): Promise<TaskWorkspace> => {
    throw new Error("must not provision");
  };
  expect(await isolateDevelopmentTask({ source: parent, isSubagent: true }, unexpected)).toBe(null);
  await expect(
    isolateDevelopmentTask(
      { source: parent, isSubagent: true, taskKind: "development" },
      unexpected,
    ),
  ).rejects.toThrow("Git checkout");
});
test("Git worktree .git files and nested project directories are recognized", async () => {
  const parent = await source(false);
  await writeFile(join(parent.cwd, ".git"), "gitdir: elsewhere");
  const cwd = join(parent.cwd, "packages", "app");
  await mkdir(cwd, { recursive: true });
  let observed = "";
  const child = await isolateDevelopmentTask(
    { source: { ...parent, cwd }, isSubagent: true },
    async (selected) => {
      observed = selected.cwd;
      return { cwd: "/new/packages/app", workspaceId: "child" };
    },
  );
  expect(observed).toBe(cwd);
  expect(child?.cwd).toBe("/new/packages/app");
});
test("provisioning failure never falls back to shared editing", async () => {
  const parent = await source();
  await expect(
    isolateDevelopmentTask({ source: parent, isSubagent: true }, async () => {
      throw new Error("setup failed");
    }),
  ).rejects.toThrow("setup failed");
});
test("cwd-locked callers cannot escape their scope through automatic worktrees", async () => {
  const parent = await source();
  await expect(
    isolateDevelopmentTask(
      { source: parent, isSubagent: true, lockedCwd: parent.cwd },
      async () => parent,
    ),
  ).rejects.toThrow("cwd-locked");
});
test("child guidance requires review before integration and preserves original task", () => {
  const prompt = developmentTaskPrompt(
    { cwd: "/task", workspaceId: "child", branchName: "task-1" },
    "Fix the voice UI",
  );
  expect(prompt).toContain("Parent uncommitted edits are not copied");
  expect(prompt).toContain("Do not merge, deploy, restart");
  expect(prompt).toContain("Finishing a turn is not proof of integration");
  expect(prompt.endsWith("Fix the voice UI")).toBe(true);
});
