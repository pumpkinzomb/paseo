import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorkspaceTaskFinalization,
  WorkspaceTaskCompletion,
  WorkspaceTaskFinalizationPreview,
} from "@getpaseo/protocol/messages";
import type { WorkspaceRegistry, PersistedWorkspaceRecord } from "./workspace-registry.js";
import { repository } from "./development-review.js";
import { runGitCommand } from "../utils/run-git-command.js";
import type { WorkspaceTaskFinalizationGate } from "./workspace-task-finalization-gate.js";
import type { TaskOwnership } from "./workspace-task-owner.js";

export interface TaskFinalizationAgents {
  ids: string[];
  revision: string;
}
export interface TaskFinalizationDependencies {
  serverId: string;
  registry: WorkspaceRegistry;
  gate: WorkspaceTaskFinalizationGate;
  appliedRevision(): Promise<string>;
  owner(record: PersistedWorkspaceRecord): Promise<TaskOwnership>;
  agents(workspaceId: string): Promise<TaskFinalizationAgents>;
  assertIdle(record: PersistedWorkspaceRecord, ids: readonly string[]): Promise<void>;
  closeIdle(ids: readonly string[], current: () => boolean): Promise<void>;
  assertNoConsumers(root: string): Promise<void>;
  exclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
  archive(workspaceId: string): Promise<void>;
}
interface Preview {
  principal: object;
  expires: number;
  task: WorkspaceTaskFinalization;
  recordRevision: string;
  agents: TaskFinalizationAgents;
  activity: number;
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function revision(record: PersistedWorkspaceRecord) {
  const {
    taskFinalization: _journal,
    taskCompletion: _completion,
    updatedAt: _updated,
    ...scope
  } = record;
  return digest(scope);
}
async function git(cwd: string, ...args: string[]) {
  const result = await runGitCommand(args, {
    cwd,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (result.exitCode || result.truncated) throw new Error(`Task Git check failed: ${args[0]}`);
  return result.stdout.trim();
}
async function absent(file: string) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
async function disposableRoots(root: string) {
  const output = await git(
    root,
    "status",
    "--porcelain=v1",
    "--ignored=matching",
    "--untracked-files=normal",
    "-z",
  );
  const roots: string[] = [];
  for (const entry of output.split("\0").filter(Boolean)) {
    if (!entry.startsWith("!! ")) throw new Error("Task checkout contains unpublished files");
    const name = entry.slice(3);
    const dependency = /(^|\/)node_modules\/$/.test(name);
    const build = /^packages\/[^/]+\/dist\/$/.test(name);
    const lab = [
      ".lab/",
      ".lab-config.json",
      ".paseo-task-artifacts/",
      "packages/app/.expo/",
      "packages/app/.vitest-screenshots/",
      "packages/desktop/electron-builder.local.cjs",
      "packages/desktop/electron-builder.developer-id.cjs",
    ].includes(name);
    if (!dependency && !build && !lab)
      throw new Error(`Unclassified ignored task data must be reviewed: ${name}`);
    roots.push(name);
  }
  return roots.sort();
}

function sameCompletionScope(
  current: WorkspaceTaskFinalization,
  frozen: WorkspaceTaskFinalization,
) {
  const scope = (task: WorkspaceTaskFinalization) => ({
    root: task.root,
    rootDevice: task.rootDevice,
    rootInode: task.rootInode,
    branch: task.branch,
    headSha: task.headSha,
    evidenceId: task.evidenceId,
    repository: task.repository,
    sourceWorkspaceId: task.sourceWorkspaceId,
    ownershipRevision: task.ownershipRevision,
    lead: task.lead,
    disposableRoots: task.disposableRoots,
  });
  return digest(scope(current)) === digest(scope(frozen));
}

type EligibleTask = PersistedWorkspaceRecord & {
  worktreeRoot: string;
  mainRepoRoot: string;
  branch: string;
  parentWorkspaceId: string;
};
function assertEligible(
  record: PersistedWorkspaceRecord,
  serverId: string,
): asserts record is EligibleTask {
  if (
    !record.isPaseoOwnedWorktree ||
    record.kind !== "worktree" ||
    (record.creatorAgent && record.creatorAgent.serverId !== serverId) ||
    !record.parentWorkspaceId ||
    !record.worktreeRoot ||
    !record.mainRepoRoot ||
    !record.branch ||
    record.branch === "main" ||
    record.background ||
    record.untrustedSource ||
    (record.workspacePurpose && record.workspacePurpose !== "task")
  )
    throw new Error("Only verified agent-created self-development tasks can be finalized");
}
async function labIdentity(record: EligibleTask) {
  const manifestPath = path.join(record.worktreeRoot, ".lab-config.json");
  const manifestInfo = await lstat(manifestPath);
  if (
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    manifestInfo.nlink !== 1 ||
    manifestInfo.size > 8192 ||
    manifestInfo.uid !== process.getuid?.()
  )
    throw new Error("Self-development task manifest changed");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.role !== "development-lab" ||
    manifest.root !== record.worktreeRoot ||
    manifest.projectSource !== record.mainRepoRoot
  )
    throw new Error("Task has no exact self-development lab authority");
  const stat = await lstat(record.worktreeRoot);
  if (stat.uid !== process.getuid?.()) throw new Error("Task checkout owner changed");

  return stat;
}

function assertRetryScope(
  record: EligibleTask,
  previous: WorkspaceTaskFinalization,
  ownership: TaskOwnership,
) {
  const evidence = record.developmentEvidence;
  const current = {
    root: record.worktreeRoot,
    branch: record.branch,
    headSha: evidence?.headSha,
    sourceWorkspaceId: evidence?.sourceWorkspaceId,
    repository: evidence?.repository,
    evidenceId: evidence?.id,
    lead: ownership.lead,
  };
  const frozen = {
    root: previous.root,
    branch: previous.branch,
    headSha: previous.headSha,
    sourceWorkspaceId: previous.sourceWorkspaceId,
    repository: previous.repository,
    evidenceId: previous.evidenceId,
    lead: previous.lead,
  };
  if (digest(current) !== digest(frozen))
    throw new Error("Original task scope changed; retry cannot adopt a different task");
}

export async function recoverTaskCompletion(
  record: PersistedWorkspaceRecord,
  registry: WorkspaceRegistry,
  gate: WorkspaceTaskFinalizationGate,
  cancellations?: { has(id: string): Promise<boolean> },
) {
  const intent = record.taskCompletion;
  if (!intent || intent.state === "invalidated" || intent.state === "retired") return;
  if (!cancellations) {
    await registry.update(record.workspaceId, (r) => ({
      ...r,
      taskCompletion: {
        ...intent,
        state: "invalidated",
        reason: "Durable cancellation storage unavailable; declaration canceled",
      },
    }));
    return;
  }
  gate.bindCompletion(record.workspaceId, intent.task.id);
  if (await cancellations.has(intent.task.id)) {
    await registry.update(record.workspaceId, (r) => ({
      ...r,
      taskCompletion: {
        ...intent,
        state: "invalidated",
        reason: "New work durably canceled completion",
      },
    }));
  }
}

/** Explicit completion of one reviewed self-development task. Never called by turn-finished. */
export class WorkspaceTaskFinalizer {
  private readonly previews = new Map<string, Preview>();
  constructor(private readonly deps: TaskFinalizationDependencies) {}

  async status(workspaceId: string) {
    const record = await this.record(workspaceId);
    return record.taskFinalization ?? null;
  }

  private async record(id: string) {
    const record = await this.deps.registry.get(id);
    if (!record) throw new Error("Task workspace unavailable");
    return record;
  }

  private async source(task: WorkspaceTaskFinalization) {
    const source = await this.record(task.sourceWorkspaceId);
    if (source.archivedAt || (await repository(source)) !== task.repository)
      throw new Error("Retained source identity changed");
    if ((await git(source.cwd, "branch", "--show-current")) !== "main")
      throw new Error("Retained source must be on local main");
    await git(source.cwd, "merge-base", "--is-ancestor", task.headSha, "refs/heads/main");
    const applied = await this.deps.appliedRevision();
    if (applied !== task.appliedRevision) throw new Error("Applied release changed; inspect again");
    await git(source.cwd, "merge-base", "--is-ancestor", task.headSha, applied);
    return source;
  }

  private async unchanged(task: WorkspaceTaskFinalization, removed: boolean) {
    const record = await this.record(task.workspaceId);
    const owner = await this.deps.owner(record);
    if (
      digest(owner.lead) !== digest(task.lead) ||
      owner.revision !== task.ownershipRevision ||
      record.developmentEvidence?.id !== task.evidenceId
    )
      throw new Error("Task owner or review evidence changed");
    const source = await this.source(task);
    const worktrees = await git(source.cwd, "worktree", "list", "--porcelain");
    if (removed) {
      if (!(await absent(task.root)) || worktrees.split("\n").includes(`worktree ${task.root}`))
        throw new Error("Task directory or Git worktree registration remains");
    } else {
      const info = await lstat(task.root);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(task.root)) !== task.root ||
        info.dev !== task.rootDevice ||
        info.ino !== task.rootInode
      )
        throw new Error("Task checkout identity changed");
      const gitFile = await lstat(path.join(task.root, ".git"));
      if (
        !gitFile.isFile() ||
        gitFile.isSymbolicLink() ||
        (await repository(record)) !== task.repository
      )
        throw new Error("Task Git ownership changed");
      if (
        !worktrees.split("\n").includes(`worktree ${task.root}`) ||
        (await git(task.root, "branch", "--show-current")) !== task.branch ||
        (await git(task.root, "rev-parse", "HEAD")) !== task.headSha
      )
        throw new Error("Task branch or tip changed");
      if (digest(await disposableRoots(task.root)) !== digest(task.disposableRoots))
        throw new Error("Task disposable output scope changed; inspect again");
    }
    return source;
  }

  async inspect(
    principal: object,
    workspaceId: string,
    declaring = false,
  ): Promise<WorkspaceTaskFinalizationPreview> {
    const record = await this.record(workspaceId);
    const result: WorkspaceTaskFinalizationPreview = {
      workspaceId,
      name: record.title || record.displayName,
      blockers: [],
    };
    try {
      if (record.taskFinalization?.phase === "retired")
        return { ...result, task: record.taskFinalization, blockers: ["Task is already retired"] };
      assertEligible(record, this.deps.serverId);
      await this.assertNotRetained(record);
      const evidence = record.developmentEvidence;
      if (!evidence) throw new Error("Capture the exact reviewed task tip before finalizing");
      const sourceRecord = await this.record(evidence.sourceWorkspaceId);
      if (sourceRecord.cwd !== record.mainRepoRoot)
        throw new Error("Task retained source is not its registered main checkout");
      const ownership = await this.deps.owner(record);
      const agents = await this.deps.agents(workspaceId);
      if (!agents.ids.length) throw new Error("Task session evidence is unavailable");
      this.deps.gate.watch(workspaceId, agents.ids);
      this.deps.gate.assertSettled(workspaceId);
      if (!declaring) await this.deps.assertIdle(record, agents.ids);
      const previous = record.taskFinalization;
      const missing = await absent(record.worktreeRoot);
      let task: WorkspaceTaskFinalization;
      if (missing) {
        if (
          !previous ||
          !["archiving", "branch-pending", "blocked"].includes(previous.phase) ||
          !record.archivedAt
        )
          throw new Error("Missing task checkout has no recoverable finalization receipt");
        assertRetryScope(record, previous, ownership);
        task = {
          ...previous,
          phase: "pending",
          updatedAt: new Date().toISOString(),
          appliedRevision: declaring ? "" : await this.deps.appliedRevision(),
          ownershipRevision: ownership.revision,
          ownershipProof: ownership.proof,
        };
      } else {
        if (record.archivedAt)
          throw new Error("Task is archived; inspect the pending finalization before restoring");
        const stat = await labIdentity(record);
        task = {
          id: randomUUID(),
          phase: "pending",
          workspaceId,
          serverId: this.deps.serverId,
          root: record.worktreeRoot,
          rootDevice: stat.dev,
          rootInode: stat.ino,
          branch: record.branch,
          headSha: evidence.headSha,
          sourceWorkspaceId: evidence.sourceWorkspaceId,
          repository: evidence.repository,
          evidenceId: evidence.id,
          appliedRevision: declaring ? "" : await this.deps.appliedRevision(),
          ownershipProof: ownership.proof,
          ownershipRevision: ownership.revision,
          disposableRoots: await disposableRoots(record.worktreeRoot),
          lead: ownership.lead,
          approvedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      if (declaring) await this.validateDeclaration(task, record, missing);
      else await this.unchanged(task, missing);
      const token = randomUUID(),
        expires = Date.now() + 5 * 60_000;
      this.prunePreviews();
      this.previews.set(token, {
        principal,
        expires,
        task,
        agents,
        recordRevision: revision(record),
        activity: this.deps.gate.revision(workspaceId),
      });
      return { ...result, task, previewToken: token, expiresAt: new Date(expires).toISOString() };
    } catch (error) {
      return {
        ...result,
        task: record.taskFinalization,
        blockers: [error instanceof Error ? error.message : "Task finalization unavailable"],
      };
    }
  }

  private prunePreviews() {
    for (const [id, value] of this.previews)
      if (value.expires < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 32) throw new Error("Too many task finalization previews");
  }

  private async assertNotRetained(record: PersistedWorkspaceRecord) {
    const workspaceId = record.workspaceId;
    const all = await this.deps.registry.listAll();
    if (
      all.some(
        (r) =>
          r.workspaceId !== workspaceId &&
          (r.parentWorkspaceId === workspaceId ||
            r.developmentSourceIds?.includes(workspaceId) ||
            (!r.archivedAt && r.worktreeRoot === record.worktreeRoot)),
      )
    )
      throw new Error("Task is a retained source, shared checkout or owns child workspaces");
  }

  private async validateDeclaration(
    task: WorkspaceTaskFinalization,
    record: PersistedWorkspaceRecord,
    missing: boolean,
  ) {
    if (missing || record.archivedAt)
      throw new Error("Completion requires a live reviewed checkout");
    if (
      (await git(task.root, "rev-parse", "HEAD")) !== task.headSha ||
      (await git(task.root, "branch", "--show-current")) !== task.branch ||
      (await repository(record)) !== task.repository
    )
      throw new Error("Reviewed task scope changed");
  }

  async declareComplete(workspaceId: string, headSha: string) {
    this.deps.gate.assertCompletionSupport?.();
    return this.deps.exclusive(workspaceId, async () => {
      const principal = {};
      const activity = this.deps.gate.revision(workspaceId);
      const preview = await this.inspect(principal, workspaceId, true);
      if (!preview.task || !preview.previewToken || preview.blockers.length)
        throw new Error(preview.blockers.join("; "));
      this.previews.delete(preview.previewToken);
      const task = preview.task;
      if (task.headSha !== headSha) throw new Error("Completion must name the exact reviewed tip");
      const record = await this.record(workspaceId);
      const existing = record.taskCompletion;
      if (existing && existing.state !== "invalidated") {
        if (existing.task.headSha !== headSha || existing.scopeRevision !== revision(record))
          throw new Error("Existing completion scope changed");
        return existing;
      }
      const agents = await this.deps.agents(workspaceId);
      const completion: WorkspaceTaskCompletion = {
        task,
        scopeRevision: revision(record),
        agentIds: agents.ids,
        state: "pending",
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
      };
      if (activity !== this.deps.gate.revision(workspaceId))
        throw new Error("New work invalidated completion declaration");
      this.deps.gate.bindCompletion(workspaceId, task.id);
      await this.deps.registry.update(workspaceId, (r) => {
        if (
          revision(r) !== completion.scopeRevision ||
          activity !== this.deps.gate.revision(workspaceId)
        )
          throw new Error("Task changed during completion");
        return { ...r, taskCompletion: completion };
      });
      return completion;
    });
  }

  /** The daemon owns retries; no client connection or expiring preview is retained. */
  async reconcileCompletions(
    now = Date.now(),
    relevantWorkspaces: ReadonlySet<string> = new Set(),
  ) {
    for (const record of await this.deps.registry.listAll()) {
      const intent = record.taskCompletion;
      if (
        !intent ||
        intent.state === "retired" ||
        intent.state === "invalidated" ||
        (Date.parse(intent.nextAttemptAt) > now && !relevantWorkspaces.has(record.workspaceId))
      )
        continue;
      await this.reconcileCompletion(record, intent, now);
    }
  }

  private async completionScopeChanged(
    record: PersistedWorkspaceRecord,
    intent: WorkspaceTaskCompletion,
  ) {
    const ownership = await this.deps.owner(record);
    const agents = await this.deps.agents(record.workspaceId);
    const frozen = intent.task;
    const removed = await absent(frozen.root);
    if (removed) {
      const source = await this.record(frozen.sourceWorkspaceId);
      const ref = await git(
        source.cwd,
        "for-each-ref",
        "--format=%(objectname)",
        `refs/heads/${frozen.branch}`,
      );
      if (ref && ref !== frozen.headSha) return true;
    }
    return (
      this.deps.gate.isCompletionCanceled(intent.task.id) ||
      (await this.deps.gate.completionCanceled?.(intent.task.id)) ||
      (!removed && revision(record) !== intent.scopeRevision) ||
      ownership.revision !== frozen.ownershipRevision ||
      digest(agents.ids) !== digest(intent.agentIds) ||
      (!removed && (await git(frozen.root, "rev-parse", "HEAD")) !== frozen.headSha)
    );
  }

  private async reconcileCompletion(
    record: PersistedWorkspaceRecord,
    intent: WorkspaceTaskCompletion,
    now: number,
  ) {
    let state: WorkspaceTaskCompletion["state"] = "blocked";
    let reason: string | undefined;
    try {
      const frozen = intent.task;
      if (await this.completionScopeChanged(record, intent)) {
        state = "invalidated";
        throw new Error("Completion scope changed; declare the reviewed task again");
      }
      if (record.taskFinalization?.phase === "retired") state = "retired";
      else {
        const activity = this.deps.gate.revision(record.workspaceId);
        const principal = {};
        const preview = await this.inspect(principal, record.workspaceId);
        if (!preview.previewToken || !preview.task || preview.blockers.length)
          throw new Error(preview.blockers.join("; "));
        if (!sameCompletionScope(preview.task, frozen)) {
          this.previews.delete(preview.previewToken);
          state = "invalidated";
          throw new Error("Reviewed output or tip changed; completion invalidated");
        }
        const result = await this.apply(
          principal,
          preview.previewToken,
          () => this.deps.gate.revision(record.workspaceId) === activity,
          intent.task.id,
        );
        state = result.phase === "retired" ? "retired" : "blocked";
        reason = result.reason;
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    await this.deps.registry.update(record.workspaceId, (r) => {
      if (r.taskCompletion?.task.id !== intent.task.id || r.taskCompletion.state === "invalidated")
        return r;
      return {
        ...r,
        taskCompletion: {
          ...intent,
          state,
          reason,
          attempts: intent.attempts + 1,
          nextAttemptAt: new Date(
            now + Math.min(300_000, 5_000 * 2 ** Math.min(intent.attempts, 6)),
          ).toISOString(),
        },
      };
    });
  }

  async apply(principal: object, token: string, authorized: () => boolean, completionId?: string) {
    const preview = this.previews.get(token);
    if (
      !preview ||
      preview.principal !== principal ||
      preview.expires < Date.now() ||
      !authorized()
    )
      throw new Error("Task completion preview expired or principal changed; inspect again");
    this.previews.delete(token);
    const task = preview.task;
    return this.deps.exclusive(task.workspaceId, async () => {
      const lease = this.deps.gate.enter(task.workspaceId);
      let saved = false;
      const current = () =>
        !lease.signal.aborted &&
        authorized() &&
        Date.now() < preview.expires &&
        this.deps.gate.revision(task.workspaceId) === preview.activity;
      const checkpoint = async () => {
        if (completionId && (await this.deps.gate.completionCanceled?.(completionId)))
          throw new Error("Completion was durably canceled by new work");
        if (!current())
          throw new Error("Task completion approval invalidated by new work or caller change");
        await this.deps.assertIdle(await this.record(task.workspaceId), preview.agents.ids);
        if (!current()) throw new Error("Task completion approval invalidated");
      };
      const write = async (phase: WorkspaceTaskFinalization["phase"], reason?: string) => {
        const next = {
          ...task,
          phase,
          updatedAt: new Date().toISOString(),
          ...(reason ? { reason } : {}),
        };
        await this.deps.registry.update(task.workspaceId, (r) => ({
          ...r,
          taskFinalization: next,
        }));
        saved = true;
        return next;
      };
      try {
        const record = await this.record(task.workspaceId);
        if (
          revision(record) !== preview.recordRevision ||
          digest(await this.deps.agents(task.workspaceId)) !== digest(preview.agents)
        )
          throw new Error("Task scope or activity changed; inspect again");
        await checkpoint();
        await this.unchanged(task, await absent(task.root));
        await write("pending");
        await this.deps.closeIdle(preview.agents.ids, current);
        await checkpoint();
        await this.deps.assertNoConsumers(task.root);
        await checkpoint();
        if (!(await absent(task.root))) {
          await this.unchanged(task, false);
          await write("archiving");
          await checkpoint();
          lease.commit();
          await this.deps.archive(task.workspaceId);
        }
        const source = await this.unchanged(task, true);
        await write("branch-pending");
        if (!current()) throw new Error("Finalization caller or activity changed; branch retained");
        await this.deps.assertNoConsumers(task.root);
        const refs = await git(
          source.cwd,
          "for-each-ref",
          "--format=%(objectname)",
          `refs/heads/${task.branch}`,
        );
        if (refs) {
          if (refs !== task.headSha) throw new Error("Task branch advanced; branch was preserved");
          await git(source.cwd, "branch", "-d", "--", task.branch);
        }
        if (
          await git(source.cwd, "for-each-ref", "--format=%(refname)", `refs/heads/${task.branch}`)
        )
          throw new Error("Task branch remains");
        return await write("retired");
      } catch (error) {
        if (!saved) throw error;
        return await write(
          lease.signal.aborted ? "invalidated" : "blocked",
          error instanceof Error ? error.message : "Task finalization failed; inspect before retry",
        );
      } finally {
        lease.close();
      }
    });
  }
}
