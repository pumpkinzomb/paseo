import {
  WorkspaceLeadAssociations,
  type LeadAssociationAgent,
} from "./workspace-lead-association.js";
import type {
  AssistantConversation,
  WorkspaceLeadAssociationAssignment,
} from "@getpaseo/protocol/messages";
import { requiredPermissionForInbound } from "./authorization/operation-permissions.js";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
  type WorkspaceMutation,
} from "./workspace-registry.js";

describe("resolveWorkspaceName", () => {
  test("prefers the user-set title over the derived display name", () => {
    expect(
      resolveWorkspaceName({ title: "Payments work", derivedDisplayName: "feature/payments" }),
    ).toBe("Payments work");
  });

  test("falls back to the derived display name when there is no title", () => {
    expect(resolveWorkspaceName({ title: null, derivedDisplayName: "feature/payments" })).toBe(
      "feature/payments",
    );
  });

  test("createPersistedWorkspaceRecord defaults background to false and preserves explicit intent", () => {
    const base = {
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout" as const,
      displayName: "main",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    };
    expect(createPersistedWorkspaceRecord(base).background).toBe(false);
    expect(createPersistedWorkspaceRecord({ ...base, background: false }).background).toBe(false);
    expect(createPersistedWorkspaceRecord({ ...base, background: true }).background).toBe(true);
  });

  test("resolveWorkspaceDisplayName applies the same rule over the persisted record", () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      title: "Renamed",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveWorkspaceDisplayName(record)).toBe("Renamed");
    expect(resolveWorkspaceDisplayName({ ...record, title: null })).toBe("main");
  });
});

describe("workspace registries", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-registry-"));
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates, updates, archives, deletes, and lists project records", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await projectRegistry.archive("remote:github.com/acme/repo", "2026-03-03T00:00:00.000Z");

    const archived = await projectRegistry.get("remote:github.com/acme/repo");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(await projectRegistry.list()).toHaveLength(1);

    await projectRegistry.remove("remote:github.com/acme/repo");
    expect(await projectRegistry.get("remote:github.com/acme/repo")).toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("writes once per mutation and skips missing-record mutations", async () => {
    let writes = 0;
    const registry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "write-count.json"),
      logger,
      {
        writeRecords: async (filePath, records) => {
          writes++;
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    const project = createPersistedProjectRecord({
      projectId: "counted",
      rootPath: tmpDir,
      kind: "git",
      displayName: "Counted",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await registry.upsert(project);
    expect(writes).toBe(1);
    await registry.update("missing", (current) => current);
    await registry.remove("missing");
    expect(writes).toBe(1);
    await registry.update(project.projectId, (current) => ({ ...current, customName: "Changed" }));
    expect(writes).toBe(2);
  });

  test("preserves a concurrent project update when archiving", async () => {
    let pauseNextWrite = false;
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const concurrentRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "concurrent-projects.json"),
      logger,
      {
        writeRecords: async (filePath, records) => {
          if (pauseNextWrite) {
            pauseNextWrite = false;
            writeStarted();
            await release;
          }
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    const project = createPersistedProjectRecord({
      projectId: "project-concurrent",
      rootPath: "/tmp/project-concurrent",
      kind: "git",
      displayName: "project-concurrent",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await concurrentRegistry.upsert(project);
    pauseNextWrite = true;

    const update = concurrentRegistry.update(project.projectId, (current) => ({
      ...current,
      customName: "Kept name",
      updatedAt: "2026-03-02T00:00:00.000Z",
    }));
    await started;
    const archive = concurrentRegistry.archive(project.projectId, "2026-03-03T00:00:00.000Z");
    releaseWrite();
    await Promise.all([update, archive]);

    expect(await concurrentRegistry.get(project.projectId)).toMatchObject({
      customName: "Kept name",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("publishes only project mutations that change the persisted lifecycle", async () => {
    await projectRegistry.initialize();
    const mutations: Array<{
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: ReturnType<typeof createPersistedProjectRecord> | null;
    }> = [];
    const unsubscribe = projectRegistry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });
    const active = createPersistedProjectRecord({
      projectId: "project-one",
      rootPath: "/tmp/project-one",
      kind: "non_git",
      displayName: "project-one",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const archived = {
      ...active,
      updatedAt: "2026-03-02T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    };

    await projectRegistry.upsert(active);
    await projectRegistry.archive(active.projectId, archived.archivedAt);
    await projectRegistry.archive(active.projectId, "2026-03-03T00:00:00.000Z");
    await projectRegistry.archive("project-unknown", "2026-03-03T00:00:00.000Z");
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove("project-unknown");

    expect(mutations).toEqual([
      { kind: "upsert", projectId: active.projectId, project: active },
      { kind: "archive", projectId: active.projectId, project: archived },
      { kind: "remove", projectId: active.projectId, project: null },
    ]);
    unsubscribe();
  });

  test("atomically allocates one opaque project for concurrent exact-root adds", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "same-root");
    const projects = await Promise.all(
      Array.from({ length: 20 }, () =>
        projectRegistry.getOrCreateActiveByRoot({
          rootPath,
          kind: "non_git",
          displayName: "same-root",
          timestamp: "2026-03-01T00:00:00.000Z",
        }),
      ),
    );

    expect(new Set(projects.map((project) => project.projectId))).toEqual(
      new Set([projects[0]!.projectId]),
    );
    expect(projects[0]!.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(await projectRegistry.list()).toHaveLength(1);
  });

  test("keeps readable legacy IDs alongside newly allocated opaque IDs", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/legacy",
        kind: "git",
        displayName: "repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    const opaque = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "/tmp/new",
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    expect((await projectRegistry.get("remote:github.com/acme/repo"))?.rootPath).toBe(
      "/tmp/legacy",
    );
    expect(opaque.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  test("allocates a fresh opaque ID when only an archived exact root exists", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "archived-root");
    const archived = createPersistedProjectRecord({
      projectId: "prj_archived",
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(archived);

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      timestamp: "2026-03-03T00:00:00.000Z",
    });

    expect(created).toMatchObject({ rootPath, archivedAt: null });
    expect(created.projectId).not.toBe(archived.projectId);
    expect(await projectRegistry.get(archived.projectId)).toEqual(archived);
  });

  test("refreshes the oldest active legacy duplicate kind without rewriting its identity", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "legacy-root");
    const oldest = createPersistedProjectRecord({
      projectId: "remote:oldest",
      rootPath,
      kind: "git",
      displayName: "oldest",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const duplicate = createPersistedProjectRecord({
      projectId: "remote:duplicate",
      rootPath,
      kind: "git",
      displayName: "duplicate",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(oldest);
    await projectRegistry.upsert(duplicate);

    await expect(
      projectRegistry.getOrCreateActiveByRoot({
        rootPath,
        kind: "non_git",
        displayName: "new-name",
        timestamp: "2026-03-03T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      ...oldest,
      kind: "non_git",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    expect(await projectRegistry.list()).toEqual([
      { ...oldest, kind: "non_git", updatedAt: "2026-03-03T00:00:00.000Z" },
      duplicate,
    ]);
  });

  test("reuses an active project for Windows lexical-equivalent root spellings", async () => {
    await projectRegistry.initialize();
    const first = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "C:\\Users\\Paseo\\Repo",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const second = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "c:/users/paseo/repo/.",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(await projectRegistry.list()).toEqual([first]);
  });

  test("keeps lexical and symlink root spellings distinct without realpath", async () => {
    await projectRegistry.initialize();
    const target = path.join(tmpDir, "target");
    const link = path.join(tmpDir, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    const targetProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: target,
      kind: "non_git",
      displayName: "target",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const linkProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: link,
      kind: "non_git",
      displayName: "link",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(linkProject.projectId).not.toBe(targetProject.projectId);
    expect(await projectRegistry.list()).toEqual([targetProject, linkProject]);
  });

  test("retries a generated project ID collision", async () => {
    const generatedIds = ["prj_collision", "prj_fresh"];
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
      { projectIdFactory: () => generatedIds.shift() ?? "prj_unexpected" },
    );
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "prj_collision",
        rootPath: path.join(tmpDir, "existing"),
        kind: "non_git",
        displayName: "existing",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: path.join(tmpDir, "new"),
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(created.projectId).toBe("prj_fresh");
    expect(await projectRegistry.list()).toHaveLength(2);
  });

  test("project record schema accepts records without customName (legacy on-disk records)", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBeNull();
  });

  test("project record persists a customName override", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/home/me/work/repo",
        kind: "git",
        displayName: "acme/repo",
        customName: "Acme (work)",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBe("Acme (work)");
    expect(record?.displayName).toBe("acme/repo");
  });

  test("creates, updates, archives, deletes, and lists workspace records", async () => {
    await workspaceRegistry.initialize();
    const mutations: WorkspaceMutation[] = [];
    workspaceRegistry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "feature/workspace",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.archive("/tmp/repo", "2026-03-03T00:00:00.000Z");

    const archived = await workspaceRegistry.get("/tmp/repo");
    expect(archived?.displayName).toBe("feature/workspace");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");

    await workspaceRegistry.remove("/tmp/repo");
    expect(mutations.at(-1)).toEqual({
      kind: "remove",
      workspaceId: "/tmp/repo",
      workspace: archived,
    });
    expect(await workspaceRegistry.get("/tmp/repo")).toBeNull();
    expect(await workspaceRegistry.listAll()).toEqual([]);
  });

  test("preserves the first workspace archive and reports whether a queued archive applied", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-one",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const events: WorkspaceMutation[] = [];
    workspaceRegistry.subscribeToMutations((event) => {
      events.push(event);
    });
    expect(
      await Promise.all([
        workspaceRegistry.archive("workspace-one", "2026-03-02T00:00:00.000Z"),
        workspaceRegistry.archive("workspace-one", "2026-03-03T00:00:00.000Z"),
      ]),
    ).toEqual([true, false]);
    expect(events.map((event) => event.kind)).toEqual(["archive"]);
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    expect(await reloaded.get("workspace-one")).toMatchObject({
      archivedAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
  });

  test("persists the consumed change request with the workspace archive", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-auto-archive",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "worktree",
        displayName: "feature",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-auto-archive", "2026-03-02T00:00:00.000Z", {
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });

    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloaded.initialize();
    expect(await reloaded.get("workspace-auto-archive")).toMatchObject({
      archivedAt: "2026-03-02T00:00:00.000Z",
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });
  });

  test("composes concurrent workspace field updates without losing either change", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        title: "Payments work",
        updatedAt: "2026-03-02T00:00:00.000Z",
      })),
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        pinnedAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      })),
    ]);

    const reloadedRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloadedRegistry.initialize();
    expect(await reloadedRegistry.get("ws-1")).toMatchObject({
      title: "Payments work",
      pinnedAt: "2026-03-03T00:00:00.000Z",
    });
  });
});

describe("intended lead association transactions", () => {
  let dir: string, registry: FileBackedWorkspaceRegistry, service: WorkspaceLeadAssociations;
  let conversations: Map<string, AssistantConversation>, agents: Map<string, LeadAssociationAgent>;
  let afterRead: (() => void) | undefined;
  const principal = {};
  const lead = {
    serverId: "host",
    roomWorkspaceId: "room",
    logicalId: "logical-A",
    anchorAgentId: "anchor-A",
  };
  const leadB = { ...lead, logicalId: "logical-B", anchorAgentId: "anchor-B" };
  const assignments: WorkspaceLeadAssociationAssignment[] = [
    { workspaceId: "source", lead, purpose: "source" },
    { workspaceId: "planned", lead: leadB, purpose: "planned" },
  ];
  const record = (id: string, parentWorkspaceId?: string) =>
    createPersistedWorkspaceRecord({
      workspaceId: id,
      parentWorkspaceId,
      projectId: "project",
      cwd: `/synthetic/${id}`,
      kind: "directory",
      displayName: id,
      createdAt: "2026-11-14T00:00:00Z",
      updatedAt: "2026-11-14T00:00:00Z",
    });
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "lead-association-"));
    registry = new FileBackedWorkspaceRegistry(
      path.join(dir, "workspaces.json"),
      createTestLogger(),
    );
    for (const id of ["room", "source", "planned"])
      await registry.upsert(record(id, id === "room" ? undefined : "room"));
    agents = new Map(
      ["anchor-A", "continuation-A", "anchor-B"].map((id) => [
        id,
        { id, workspaceId: "room", title: id, labels: { "paseo.role": "assistant" } },
      ]),
    );
    const conversation = (id: string, ids: string[]): AssistantConversation => ({
      logicalId: id,
      activeAgentId: ids.at(-1)!,
      activeWorkspaceId: "room",
      segments: ids.map((agentId) => ({
        agentId,
        workspaceId: "room",
        provider: "codex",
        model: null,
        createdAt: "2026-11-14T00:00:00Z",
      })),
    });
    conversations = new Map([
      ["logical-A", conversation("logical-A", ["anchor-A", "continuation-A"])],
      ["logical-B", conversation("logical-B", ["anchor-B"])],
    ]);
    afterRead = undefined;
    service = new WorkspaceLeadAssociations({
      serverId: "host",
      registry,
      getAgent: async (id) => agents.get(id) ?? null,
      getConversation: async (input) =>
        conversations.get(
          input.logicalId ?? (input.agentId === "anchor-B" ? "logical-B" : "logical-A"),
        ) ?? null,
      listAgents: async (ids) => {
        const result = [...agents.values()].filter((a) => ids.includes(a.workspaceId ?? ""));
        afterRead?.();
        return result;
      },
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  test("permissions require workspace.manage for inspection and apply", () => {
    expect(requiredPermissionForInbound("workspace.leadAssociation.inspect.request")).toBe(
      "workspace.manage",
    );
    expect(requiredPermissionForInbound("workspace.leadAssociation.apply.request")).toBe(
      "workspace.manage",
    );
  });
  test("adds distinct purpose and intended ownership without fabricating creator; retains archive/reload", async () => {
    await registry.update("source", (r) => ({
      ...r,
      creatorAgent: { serverId: "host", agentId: "another-creator" },
    }));
    const preview = await service.inspect(principal, "room", assignments);
    expect(preview.entries.map((e) => [e.purpose, e.sessionCount])).toEqual([
      ["source", 0],
      ["planned", 0],
    ]);
    expect(JSON.stringify(preview)).not.toContain("/synthetic");
    await service.apply(principal, preview.previewToken, () => true);
    expect((await registry.get("source"))?.creatorAgent?.agentId).toBe("another-creator");
    await registry.archive("planned", "2026-11-14T01:00:00Z");
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(dir, "workspaces.json"),
      createTestLogger(),
    );
    expect((await reloaded.get("planned"))?.leadAssociation).toEqual(leadB);
    expect((await reloaded.get("planned"))?.workspacePurpose).toBe("planned");
    const again = await service.inspect(principal, "room", assignments);
    await expect(service.apply(principal, again.previewToken, () => true)).resolves.toEqual([
      "source",
      "planned",
    ]);
  });
  test("rejects forged canonical IDs, foreign host, wrong room, cycles and cross-room batch", async () => {
    for (const wrong of [
      { ...lead, serverId: "foreign" },
      { ...lead, anchorAgentId: "continuation-A" },
      { ...lead, logicalId: "forged" },
      { ...lead, roomWorkspaceId: "foreign-room" },
    ])
      await expect(
        service.inspect(principal, "room", [{ ...assignments[0]!, lead: wrong }]),
      ).rejects.toThrow();
    await registry.upsert(record("outside", "elsewhere"));
    await expect(
      service.inspect(principal, "room", [
        ...assignments,
        { workspaceId: "outside", lead, purpose: "task" },
      ]),
    ).rejects.toThrow();
    await registry.update("source", (r) => ({ ...r, parentWorkspaceId: "source" }));
    await expect(service.inspect(principal, "room", assignments)).rejects.toThrow();
    expect((await registry.get("planned"))?.leadAssociation).toBeUndefined();
  });
  test("binds preview to principal/current authority and rejects changed whole-batch preimages", async () => {
    const preview = await service.inspect(principal, "room", assignments);
    await expect(service.apply({}, preview.previewToken, () => true)).rejects.toThrow();
    await expect(service.apply(principal, preview.previewToken, () => false)).rejects.toThrow();
    await registry.update("planned", (r) => ({ ...r, title: "Concurrent change" }));
    await expect(service.apply(principal, preview.previewToken, () => true)).rejects.toThrow(
      /changed/,
    );
    expect((await registry.get("source"))?.leadAssociation).toBeUndefined();
    expect((await registry.get("planned"))?.leadAssociation).toBeUndefined();
  });
  test("rejects changed provider/archival evidence and does not partially apply", async () => {
    const preview = await service.inspect(principal, "room", assignments);
    agents.set("task", {
      id: "task",
      workspaceId: "planned",
      labels: { "paseo.parent-server-id": "host", "paseo.parent-agent-id": "continuation-A" },
    });
    await expect(service.apply(principal, preview.previewToken, () => true)).rejects.toThrow(
      /conflicts/,
    );
    expect((await registry.get("source"))?.leadAssociation).toBeUndefined();
    agents.delete("task");
    agents.set("continuation-A", {
      ...agents.get("continuation-A")!,
      archivedAt: "2026-11-14T01:00:00Z",
    });
    await expect(service.apply(principal, preview.previewToken, () => true)).rejects.toThrow(
      /unavailable/,
    );
  });
  test("rechecks authorization after async evidence read and rejects different existing association", async () => {
    const preview = await service.inspect(principal, "room", assignments);
    let authorized = true;
    afterRead = () => {
      authorized = false;
    };
    await expect(
      service.apply(principal, preview.previewToken, () => authorized),
    ).rejects.toThrow();
    expect((await registry.get("source"))?.leadAssociation).toBeUndefined();
    afterRead = undefined;
    await registry.update("planned", (r) => ({ ...r, leadAssociation: lead }));
    await expect(service.inspect(principal, "room", assignments)).rejects.toThrow(
      /different intended lead/,
    );
  });
  test("atomic write failure leaves every record and persisted preimage unchanged", async () => {
    const failing = new FileBackedWorkspaceRegistry(
      path.join(dir, "workspaces.json"),
      createTestLogger(),
      {
        writeRecords: async () => {
          throw new Error("simulated disk failure");
        },
      },
    );
    const failingService = new WorkspaceLeadAssociations({
      serverId: "host",
      registry: failing,
      getAgent: async (id) => agents.get(id) ?? null,
      getConversation: async (input) => conversations.get(input.logicalId ?? "logical-A") ?? null,
      listAgents: async () => [],
    });
    const preview = await failingService.inspect(principal, "room", assignments);
    await expect(failingService.apply(principal, preview.previewToken, () => true)).rejects.toThrow(
      "simulated disk failure",
    );
    expect((await failing.get("source"))?.leadAssociation).toBeUndefined();
    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(dir, "workspaces.json"),
      createTestLogger(),
    );
    expect((await reloaded.get("planned"))?.leadAssociation).toBeUndefined();
  });
  test("target archival during evidence read aborts the entire transaction", async () => {
    const preview = await service.inspect(principal, "room", assignments);
    afterRead = () =>
      agents.set("continuation-A", {
        ...agents.get("continuation-A")!,
        archivedAt: "2026-11-14T01:00:00Z",
      });
    await expect(service.apply(principal, preview.previewToken, () => true)).rejects.toThrow(
      /unavailable/,
    );
    expect((await registry.get("source"))?.leadAssociation).toBeUndefined();
    expect((await registry.get("planned"))?.leadAssociation).toBeUndefined();
  });
  test("authenticated caller follows provider segments and parent chain; cycles/foreign parents cannot assign", async () => {
    agents.set("child", {
      id: "child",
      workspaceId: "source",
      labels: { "paseo.parent-server-id": "host", "paseo.parent-agent-id": "continuation-A" },
    });
    expect(await service.forCaller("child", "source")).toEqual(lead);
    await registry.update("source", (r) => ({ ...r, leadAssociation: leadB }));
    expect(await service.forCaller("child", "source")).toEqual(leadB);
    await registry.update("source", (r) => ({ ...r, leadAssociation: undefined }));
    await expect(service.forCaller("child", "wrong-workspace")).rejects.toThrow();
    agents.set("child", {
      id: "child",
      workspaceId: "source",
      labels: { "paseo.parent-server-id": "foreign", "paseo.parent-agent-id": "anchor-A" },
    });
    expect(await service.forCaller("child", "source")).toBeUndefined();
    agents.set("child", {
      id: "child",
      workspaceId: "source",
      labels: { "paseo.parent-server-id": "host", "paseo.parent-agent-id": "child" },
    });
    expect(await service.forCaller("child", "source")).toBeUndefined();
  });
});
