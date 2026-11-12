import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type TaskKind = "development" | "read-only";
export interface TaskWorkspace {
  cwd: string;
  workspaceId: string;
  branchName?: string;
}

async function hasGitCheckout(cwd: string): Promise<boolean> {
  let current = resolve(cwd);
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** A new writable Git child never shares its parent's checkout. Not an OS sandbox. */
export async function isolateDevelopmentTask(
  input: {
    source: TaskWorkspace;
    isSubagent: boolean;
    taskKind?: TaskKind;
    lockedCwd?: string;
  },
  createWorktree: (source: TaskWorkspace, slug: string) => Promise<TaskWorkspace>,
): Promise<TaskWorkspace | null> {
  if (!input.isSubagent || input.taskKind === "read-only") return null;
  if (!(await hasGitCheckout(input.source.cwd))) {
    if (input.taskKind === "development")
      throw new Error(
        "Development tasks require a Git checkout; select the project workspace first",
      );
    return null;
  }
  // A locked caller must not acquire an out-of-scope path by automatic provisioning.
  if (input.lockedCwd)
    throw new Error(
      "This caller is cwd-locked; it cannot provision a separate development worktree",
    );
  return createWorktree(input.source, `task-${randomUUID()}`);
}

export function developmentTaskPrompt(workspace: TaskWorkspace, prompt: string): string {
  return [
    "This is a separate Paseo-managed development task.",
    `Work only in your assigned checkout ${JSON.stringify(workspace.cwd)} on branch ${JSON.stringify(workspace.branchName)}.`,
    "The checkout starts at the selected source's committed HEAD. Parent uncommitted edits are not copied. Do not switch to the shared lab or modify another agent's worktree.",
    "Use the managed dependency preparation/reuse flow; do not copy/install dependencies as an ad-hoc fallback. Keep build outputs inside this task workspace.",
    "When done, review your diff, run relevant tests, and commit only your task changes. Report commit IDs, tests and any blockers to the lead. Do not merge, deploy, restart or delete the source workspace as a side effect of finishing.",
    "For further editing delegation use Paseo create_agent, not a native provider child sharing this directory. The lead reviews and integrates the result using the existing Git merge workflow. Finishing a turn is not proof of integration. Managed maintenance reclaims completed, integrated dependencies after usage checks; source commits and user data remain.",
    "Task:",
    prompt,
  ].join("\n");
}

export function developmentTaskResultGuidance(workspace: TaskWorkspace | null): string {
  if (!workspace) return "";
  return ` Isolated development branch ${workspace.branchName} at ${workspace.cwd}. Parent uncommitted edits were not copied. Review the child's diff and test evidence before integrating its commits. Do not treat turn completion as merge approval; use the existing Git merge workflow within the user's authorization, then managed cleanup after integration and usage checks.`;
}
