import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage, parseStoredAgentRecord } from "./agent/agent-storage.js";
import { WorkspaceArchiveOperations } from "./workspace-archive-operations.js";
import { archiveByScope, type ArchiveDependencies } from "./workspace-archive-service.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pino from "pino";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { DevelopmentReview } from "./development-review.js";
import { WorkspaceTaskFinalizer } from "./workspace-task-finalization.js";
import { WorkspaceTaskFinalizationGate } from "./workspace-task-finalization-gate.js";
import { resolveTaskOwnership, type TaskParentRecord } from "./workspace-task-owner.js";
import { requiredPermissionForInbound } from "./authorization/operation-permissions.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "task-finalization-")));
  roots.push(root);
  const source = path.join(root, "source"),
    task = path.join(root, "task");
  await mkdir(source);
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (...args: string[]) => run(source, ...args);
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(path.join(source, ".git/info/exclude"), ".lab-config.json\n");
  await writeFile(path.join(source, "source.txt"), "retained source\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("worktree", "add", "--quiet", "-b", "task-reviewed", task);
  await writeFile(
    path.join(task, ".lab-config.json"),
    JSON.stringify({ role: "development-lab", root: task, projectSource: source }),
  );
  await writeFile(path.join(task, "task.txt"), "reviewed work\n");
  run(task, "add", "task.txt");
  run(task, "commit", "--quiet", "-m", "task");
  const head = run(task, "rev-parse", "HEAD");
  git("merge", "--quiet", "--ff-only", head);
  const logger = pino({ level: "silent" }),
    registryPath = path.join(root, "workspaces.json");
  const registry = new FileBackedWorkspaceRegistry(registryPath, logger);
  for (const [id, cwd] of [
    ["room", root],
    ["source", source],
    ["task", task],
  ] as const) {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: id,
        projectId: "project",
        cwd,
        displayName: id,
        kind: id === "task" ? "worktree" : "directory",
        createdAt: "now",
        updatedAt: "now",
        ...(id === "task"
          ? {
              parentWorkspaceId: "room",
              worktreeRoot: task,
              mainRepoRoot: source,
              branch: "task-reviewed",
              isPaseoOwnedWorktree: true,
              workspacePurpose: "task",
              creatorAgent: { serverId: "host", agentId: "lead" },
            }
          : {}),
      }),
    );
  }
  const review = new DevelopmentReview(registry);
  await review.link("room", "source");
  await review.capture("room", "task", "source", base);
  const gate = new WorkspaceTaskFinalizationGate();
  const state = {
    busy: false,
    consumers: false,
    applied: head,
    failArchive: false,
    closes: 0,
    archives: 0,
    onClose: () => {},
  };
  const lead = {
    serverId: "host",
    roomWorkspaceId: "room",
    logicalId: "logical",
    anchorAgentId: "lead",
  };
  const parents = new Map<string, TaskParentRecord>([
    [
      "worker",
      {
        id: "worker",
        workspaceId: "task",
        labels: { "paseo.parent-agent-id": "lead", "paseo.parent-server-id": "host" },
      },
    ],
    ["lead", { id: "lead", workspaceId: "room", labels: { "paseo.role": "assistant" } }],
    [
      "continuation",
      { id: "continuation", workspaceId: "room", labels: { "paseo.role": "assistant" } },
    ],
  ]);
  const taskAgents = () => [...parents.values()].filter((agent) => agent.workspaceId === "task");
  const deps = {
    serverId: "host",
    registry,
    gate,
    appliedRevision: async () => {
      if (!state.applied) throw new Error("Applied release authority unavailable");
      return state.applied;
    },
    owner: (record: import("./workspace-registry.js").PersistedWorkspaceRecord) =>
      resolveTaskOwnership(record, taskAgents(), {
        serverId: "host",
        getAgent: async (id) => parents.get(id) ?? null,
        leadForAgent: async () => lead,
        canonical: async () => ({
          logicalId: "logical",
          activeAgentId: "continuation",
          activeWorkspaceId: "room",
          segments: ["lead", "continuation"].map((agentId) => ({
            agentId,
            workspaceId: "room",
            provider: "codex",
            model: null,
            createdAt: "now",
          })),
        }),
      }),
    agents: async () => ({
      ids: taskAgents().map((agent) => agent.id),
      revision: JSON.stringify(taskAgents()),
    }),
    assertIdle: async () => {
      if (state.busy) throw new Error("Task has running work or pending delivery");
    },
    closeIdle: async (_ids: readonly string[], current: () => boolean) => {
      state.onClose();
      if (!current()) throw new Error("New task activity");
      state.closes++;
    },
    assertNoConsumers: async () => {
      if (state.consumers) throw new Error("Task has external open consumers");
    },
    exclusive: async <T>(_id: string, operation: () => Promise<T>) => operation(),
    archive: async (id: string) => {
      state.archives++;
      git("worktree", "remove", "--force", task);
      await registry.archive(id, new Date().toISOString());
      if (state.failArchive) throw new Error("Archive outcome needs verification");
    },
  };
  const service = new WorkspaceTaskFinalizer(deps);
  return {
    root,
    source,
    task,
    head,
    base,
    registry,
    registryPath,
    review,
    gate,
    state,
    service,
    git,
    run,
    logger,
    deps,
    parents,
    lead,
  };
}

it("retires only the reviewed applied task; persisted evidence reads survive a fresh store after folder/branch removal", async () => {
  const f = await fixture(),
    principal = {};
  const scopes = await f.review.list("room");
  const pinned = scopes.find((s) => s.workspaceId === "task" && s.evidenceId)!;
  expect(scopes.some((s) => s.workspaceId === "task")).toBe(true); // Integrated does not mean retired.
  const preview = await f.service.inspect(principal, "task");
  expect(preview.blockers).toEqual([]);
  const result = await f.service.apply(principal, preview.previewToken!, () => true);
  expect(result.phase).toBe("retired");
  await expect(access(f.task)).rejects.toThrow();
  expect(f.git("branch", "--list", "task-reviewed")).toBe("");
  expect(f.git("worktree", "list", "--porcelain")).not.toContain(`worktree ${f.task}`);
  expect(await readFile(path.join(f.source, "source.txt"), "utf8")).toBe("retained source\n");
  const fresh = new FileBackedWorkspaceRegistry(f.registryPath, f.logger);
  const review = new DevelopmentReview(fresh);
  expect((await review.list("room")).some((s) => s.workspaceId === "task")).toBe(false);
  expect((await review.list("room")).some((s) => s.workspaceId === "source")).toBe(true);
  const data = await review.read({
    type: "workspace.development.read.request",
    requestId: "fresh",
    workspaceId: "room",
    scopeWorkspaceId: "task",
    evidenceId: pinned.evidenceId,
    scopeToken: pinned.scopeToken,
    operation: "file",
    path: "task.txt",
  });
  expect(data.content).toBe("reviewed work\n");
  const diff = await review.read({
    type: "workspace.development.read.request",
    requestId: "diff",
    workspaceId: "room",
    scopeWorkspaceId: "task",
    evidenceId: pinned.evidenceId,
    scopeToken: pinned.scopeToken,
    operation: "diff",
  });
  expect(diff.diff).toContain("+reviewed work");
  await expect(
    review.read({
      type: "workspace.development.read.request",
      requestId: "live",
      workspaceId: "room",
      scopeWorkspaceId: "task",
      operation: "tree",
    }),
  ).rejects.toThrow(/retired|unavailable/i);

  expect((await fresh.get("task"))?.developmentEvidence?.headSha).toBe(f.head);
});

it("requires applied release evidence rather than local merge, idle or matching semantic version", async () => {
  const f = await fixture();
  f.state.applied = f.base;
  expect((await f.service.inspect({}, "task")).previewToken).toBeUndefined();
  f.state.applied = "";
  expect((await f.service.inspect({}, "task")).blockers).toEqual([
    "Applied release authority unavailable",
  ]);
  expect(f.state.archives).toBe(0);
  await access(f.task);
});

it.each(["planned", "source", "preparation"] as const)(
  "never infers completion of %s work from ancestry",
  async (purpose) => {
    const f = await fixture();
    await f.registry.update("task", (r) => ({ ...r, workspacePurpose: purpose }));
    expect((await f.service.inspect({}, "task")).previewToken).toBeUndefined();
    expect(f.state.archives).toBe(0);
  },
);

it("rejects stale tip, dirty checkout, foreign creator and another connection's approval", async () => {
  const f = await fixture(),
    principal = {};
  const preview = await f.service.inspect(principal, "task");
  await expect(f.service.apply({}, preview.previewToken!, () => true)).rejects.toThrow("principal");
  await writeFile(path.join(f.task, "unpublished.txt"), "user work");
  expect((await f.service.inspect(principal, "task")).blockers).toContain(
    "Task checkout contains unpublished files",
  );
  await expect(f.service.apply(principal, preview.previewToken!, () => true)).rejects.toThrow();
  await f.registry.update("task", (r) => ({
    ...r,
    creatorAgent: { serverId: "foreign", agentId: "lead" },
  }));
  expect((await f.service.inspect(principal, "task")).previewToken).toBeUndefined();
  expect(f.state.archives).toBe(0);
});

it("invalidates approved completion when continuation is admitted or deliveries become pending", async () => {
  const f = await fixture(),
    principal = {};
  const preview = await f.service.inspect(principal, "task");
  f.gate.agentActivity("worker");
  await expect(f.service.apply(principal, preview.previewToken!, () => true)).rejects.toThrow(
    "invalidated",
  );
  f.state.busy = true;
  expect((await f.service.inspect(principal, "task")).blockers).toEqual([
    "Task has running work or pending delivery",
  ]);
  expect(f.state.archives).toBe(0);
});

it("rejects own/foreign open consumers and cancels a close racing new work without removing the checkout", async () => {
  const f = await fixture(),
    principal = {};
  f.state.consumers = true;
  const preview = await f.service.inspect(principal, "task");
  const blocked = await f.service.apply(principal, preview.previewToken!, () => true);
  expect(blocked.phase).toBe("blocked");
  expect(blocked.reason).toBe("Task has external open consumers");
  f.state.consumers = false;
  f.state.onClose = () => f.gate.agentActivity("worker");
  const next = await f.service.inspect(principal, "task");
  expect((await f.service.apply(principal, next.previewToken!, () => true)).phase).toBe(
    "invalidated",
  );
  await access(f.task);
  expect(f.state.archives).toBe(0);
});

it("resumes an interrupted archive from durable scope without treating its own journal writes as user changes", async () => {
  const f = await fixture(),
    principal = {};
  f.state.failArchive = true;
  const preview = await f.service.inspect(principal, "task");
  expect((await f.service.apply(principal, preview.previewToken!, () => true)).phase).toBe(
    "blocked",
  );
  expect(f.git("branch", "--list", "task-reviewed")).toContain("task-reviewed");
  const freshRegistry = new FileBackedWorkspaceRegistry(f.registryPath, f.logger);
  const service = new WorkspaceTaskFinalizer({ ...f.deps, registry: freshRegistry });
  const next = await service.inspect(principal, "task");
  expect(next.blockers).toEqual([]);
  expect((await service.apply(principal, next.previewToken!, () => true)).phase).toBe("retired");
  expect(f.state.archives).toBe(1);
});

it("scoped admission blocks finalization while a terminal/setup request is still entering", async () => {
  const f = await fixture();
  const release = f.gate.admit("task");
  expect((await f.service.inspect({}, "task")).blockers).toEqual([
    "Task activity admission is pending",
  ]);
  expect(() => f.gate.enter("task")).toThrow("pending");
  const other = f.gate.enter("other-task");
  other.close();
  release();
  expect((await f.service.inspect({}, "task")).blockers).toEqual([]);
});

it("preserves ignored user data rather than classifying every clean worktree as disposable", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.source, ".git/info/exclude"),
    ".lab-config.json\nprivate-notes.txt\n",
  );
  await writeFile(path.join(f.task, "private-notes.txt"), "user notes");
  expect((await f.service.inspect({}, "task")).blockers).toEqual([
    "Unclassified ignored task data must be reviewed: private-notes.txt",
  ]);
  expect(await readFile(path.join(f.task, "private-notes.txt"), "utf8")).toBe("user notes");
  expect(f.state.archives).toBe(0);
});

it("legacy labels alone grant no retirement; reviewed host intent supports unanimous provider-segment and internal-parent evidence", async () => {
  const f = await fixture(),
    principal = {};
  await f.registry.update("task", (r) => ({
    ...r,
    creatorAgent: undefined,
    workspacePurpose: undefined,
  }));
  expect((await f.service.inspect(principal, "task")).blockers[0]).toContain(
    "Legacy task ownership review required",
  );
  expect(requiredPermissionForInbound("update_agent_request")).toBe("workspace.write");
  expect(requiredPermissionForInbound("workspace.leadAssociation.apply.request")).toBe(
    "workspace.manage",
  );
  expect(requiredPermissionForInbound("workspace.taskFinalization.apply.request")).toBe(
    "workspace.manage",
  );
  await f.registry.update("task", (r) => ({
    ...r,
    leadAssociation: f.lead,
    workspacePurpose: "task",
  }));
  f.parents.get("worker")!.labels["paseo.parent-agent-id"] = "continuation";
  f.parents.set("internal-child", {
    id: "internal-child",
    workspaceId: "task",
    labels: { "paseo.parent-agent-id": "worker", "paseo.parent-server-id": "host" },
  });
  const preview = await f.service.inspect(principal, "task");
  expect(preview.blockers).toEqual([]);
  expect(preview.task?.ownershipProof).toBe("reviewed-legacy-intent");
  await expect(f.service.apply(principal, preview.previewToken!, () => false)).rejects.toThrow(
    "principal",
  );
  expect(f.state.archives).toBe(0);
});

it.each(["missing", "unparented", "foreign", "cycle", "conflicting"] as const)(
  "legacy %s parent evidence blocks retirement even with declared intent",
  async (kind) => {
    const f = await fixture();
    await f.registry.update("task", (r) => ({
      ...r,
      creatorAgent: undefined,
      leadAssociation: f.lead,
      workspacePurpose: "task",
    }));
    const worker = f.parents.get("worker")!;
    if (kind === "missing") f.parents.delete("lead");
    if (kind === "unparented") worker.labels = {};
    if (kind === "foreign") worker.labels["paseo.parent-server-id"] = "foreign";
    if (kind === "cycle") worker.labels["paseo.parent-agent-id"] = "worker";
    if (kind === "conflicting") {
      worker.labels["paseo.parent-agent-id"] = "other-lead";
      f.parents.set("other-lead", {
        id: "other-lead",
        workspaceId: "room",
        labels: { "paseo.role": "assistant" },
      });
    }
    expect((await f.service.inspect({}, "task")).previewToken).toBeUndefined();
    expect(f.state.archives).toBe(0);
  },
);

it("source references and contradictory creator authority stay protected without a purpose flag", async () => {
  const f = await fixture();
  await f.registry.update("room", (r) => ({ ...r, developmentSourceIds: ["source", "task"] }));
  await f.registry.update("task", (r) => ({ ...r, workspacePurpose: undefined }));
  expect((await f.service.inspect({}, "task")).blockers[0]).toContain("retained source");
  await f.registry.update("room", (r) => ({ ...r, developmentSourceIds: ["source"] }));
  await f.registry.update("task", (r) => ({
    ...r,
    leadAssociation: { ...f.lead, logicalId: "another-lead" },
  }));
  expect((await f.service.inspect({}, "task")).blockers[0]).toContain("contradicts creator");
});

it("changing parent or full agent inventory after preview invalidates the token before any side effect", async () => {
  const f = await fixture(),
    principal = {};
  const preview = await f.service.inspect(principal, "task");
  f.parents.get("worker")!.labels["paseo.parent-agent-id"] = "continuation";
  await expect(f.service.apply(principal, preview.previewToken!, () => true)).rejects.toThrow(
    "scope or activity changed",
  );
  const next = await f.service.inspect(principal, "task");
  f.parents.set("new-worker", {
    id: "new-worker",
    workspaceId: "task",
    labels: { "paseo.parent-agent-id": "lead", "paseo.parent-server-id": "host" },
  });
  await expect(f.service.apply(principal, next.previewToken!, () => true)).rejects.toThrow(
    "scope or activity changed",
  );
  expect(f.state.closes).toBe(0);
  expect(f.state.archives).toBe(0);
});

it("preserves an advanced branch instead of marking partial retirement successful", async () => {
  const f = await fixture(),
    principal = {};
  const preview = await f.service.inspect(principal, "task");
  const changed = f.git("commit-tree", `${f.head}^{tree}`, "-p", f.head, "-m", "external work");
  const archive = f.deps.archive;
  f.deps.archive = async (id) => {
    await archive(id);
    f.git("update-ref", "refs/heads/task-reviewed", changed);
  };
  const result = await f.service.apply(principal, preview.previewToken!, () => true);
  expect(result.phase).toBe("blocked");
  expect(result.reason).toContain("branch advanced");
  expect(f.git("rev-parse", "refs/heads/task-reviewed")).toBe(changed);
  expect((await f.registry.get("task"))?.taskFinalization?.phase).toBe("blocked");
});

it("composes the real deletion fence, archive queue, stored-agent archive and worktree removal without self-invalidation", async () => {
  const f = await fixture();
  const storage = new AgentStorage(path.join(f.root, "agents"), f.logger);
  await storage.initialize();
  await storage.upsert(
    parseStoredAgentRecord({
      id: "worker",
      provider: "codex",
      cwd: f.task,
      workspaceId: "task",
      createdAt: "now",
      updatedAt: "now",
      labels: f.parents.get("worker")!.labels,
    }),
  );
  const manager = new AgentManager({ clients: {}, registry: storage, logger: f.logger });
  const queue = new WorkspaceArchiveOperations();
  f.deps.gate = manager.taskFinalizationGate;
  f.deps.exclusive = (id, operation) => manager.withWorkspaceSessionDeletion(id, operation);
  const archivePorts: ArchiveDependencies = {
    agentManager: manager,
    agentStorage: storage,
    github: { invalidate: vi.fn() } as unknown as ArchiveDependencies["github"],
    workspaceGitService: { getSnapshot: vi.fn(), invalidateWorktrees: vi.fn() },
    findWorkspaceIdForCwd: async () => "task",
    getWorkspace: (id) => f.registry.get(id),
    listActiveWorkspaces: async () => (await f.registry.listAll()).filter((r) => !r.archivedAt),
    archiveWorkspaceRecord: async (id) => {
      await f.registry.archive(id, new Date().toISOString());
    },
    emitWorkspaceUpdatesForWorkspaceIds: async () => {},
    markWorkspaceArchiving: () => {},
    clearWorkspaceArchiving: () => {},
    killTerminalsForWorkspace: async () => {},
    sessionLogger: f.logger,
  };
  f.deps.archive = async (id) => {
    const outcome = await queue.archive(id, (signal) =>
      archiveByScope(archivePorts, {
        scope: { kind: "workspace", workspaceId: id },
        requestId: "review",
        signal,
      }),
    );
    expect(outcome.kind).toBe("archived");
    if (outcome.kind !== "archived" || !outcome.result.removedDirectory)
      throw Error("Task archive did not verify checkout removal");
  };
  const service = new WorkspaceTaskFinalizer(f.deps),
    principal = {};
  const preview = await service.inspect(principal, "task");
  expect(preview.blockers).toEqual([]);
  const result = await service.apply(principal, preview.previewToken!, () => true);
  expect(result.phase).toBe("retired");
  expect((await storage.get("worker"))?.archivedAt).toBeTruthy();
  expect(f.git("branch", "--list", "task-reviewed")).toBe("");
  await manager.withWorkspaceSessionDeletion("task", async () => {});
});
