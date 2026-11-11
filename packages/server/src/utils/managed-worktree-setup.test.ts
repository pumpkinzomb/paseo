import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getWorktreeSetupCommands } from "./worktree.js";

test("managed self-development overrides legacy installers but leaves other repositories alone", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "managed-setup-")));
  const source = join(base, "source"),
    child = join(base, "child"),
    other = join(base, "other");
  const oldHelper = process.env.PASEO_WORKTREE_SETUP_HELPER;
  const oldContext = process.env.PASEO_WORKTREE_DEPENDENCY_CONTEXT;
  try {
    for (const root of [source, other]) {
      await mkdir(root);
      execFileSync("git", ["init", "-q", root]);
      await writeFile(
        join(root, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: ["npm ci", "node scripts/seed-worktree-dev-state.mjs"],
          },
        }),
      );
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: root },
      );
    }
    execFileSync("git", ["worktree", "add", "-q", "--detach", child], {
      cwd: source,
    });
    process.env.PASEO_WORKTREE_SETUP_HELPER = join(base, "trusted-helper.mjs");
    process.env.PASEO_WORKTREE_DEPENDENCY_CONTEXT = JSON.stringify({
      sourceRoot: source,
    });
    expect(await getWorktreeSetupCommands(child)).toEqual([
      'node "$PASEO_WORKTREE_SETUP_HELPER"',
      "npm run build:server",
      "npm run build --workspace=@getpaseo/expo-two-way-audio",
    ]);
    expect(await getWorktreeSetupCommands(other)).toEqual([
      "npm ci",
      "node scripts/seed-worktree-dev-state.mjs",
    ]);
  } finally {
    if (oldHelper === undefined) delete process.env.PASEO_WORKTREE_SETUP_HELPER;
    else process.env.PASEO_WORKTREE_SETUP_HELPER = oldHelper;
    if (oldContext === undefined) delete process.env.PASEO_WORKTREE_DEPENDENCY_CONTEXT;
    else process.env.PASEO_WORKTREE_DEPENDENCY_CONTEXT = oldContext;
    await rm(base, { recursive: true, force: true });
  }
});
