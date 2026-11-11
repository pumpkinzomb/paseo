import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  assistantWorkspaceDirectory,
  isAssistantScratchDirectory,
} from "../default-assistant/index.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { renameLegacyDefaultAssistantNames } from "./rename-default-assistant.migration.js";

const NOW = "2026-03-01T00:00:00.000Z";

describe("renameLegacyDefaultAssistantNames", () => {
  let root: string;
  let paseoHome: string;
  let agentStorage: AgentStorage;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let scratch: string;
  let gitScratch: string;
  const userProject = "/tmp/user-project";

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "paseo-lead-agent-"));
    paseoHome = path.join(root, "home");
    scratch = assistantWorkspaceDirectory({ paseoHome, requestKey: "a", gitRoot: null });
    gitScratch = assistantWorkspaceDirectory({
      paseoHome,
      requestKey: "b",
      gitRoot: path.join(root, "repo"),
    });
    agentStorage = new AgentStorage(path.join(root, "agents"), createTestLogger());
    await agentStorage.initialize();
    projectRegistry = new FileBackedProjectRegistry(
      path.join(root, "projects.json"),
      createTestLogger(),
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(root, "workspaces.json"),
      createTestLogger(),
    );
    await Promise.all([projectRegistry.initialize(), workspaceRegistry.initialize()]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function seedProject(projectId: string, rootPath: string, customName: string | null) {
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId,
        rootPath,
        kind: "non_git",
        displayName: path.basename(rootPath),
        customName,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  async function seedWorkspace(workspaceId: string, cwd: string, title: string | null) {
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: workspaceId,
        cwd,
        kind: "directory",
        displayName: path.basename(cwd),
        title,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  async function seedAgent(id: string, title: string | null, labels: Record<string, string>) {
    await agentStorage.upsert({
      id,
      provider: "codex",
      cwd: scratch,
      createdAt: NOW,
      updatedAt: NOW,
      lastActivityAt: NOW,
      lastUserMessageAt: null,
      title,
      labels,
      lastStatus: "closed",
      lastModeId: null,
      config: null,
      runtimeInfo: { provider: "codex", sessionId: null },
      persistence: null,
      archivedAt: null,
    });
  }

  function migrate() {
    return renameLegacyDefaultAssistantNames({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      logger: createTestLogger(),
    });
  }

  test("recognizes only scratch directories made for this Paseo home", () => {
    expect(isAssistantScratchDirectory({ paseoHome, directory: scratch })).toBe(true);
    expect(isAssistantScratchDirectory({ paseoHome, directory: gitScratch })).toBe(true);
    expect(isAssistantScratchDirectory({ paseoHome, directory: userProject })).toBe(false);
    expect(isAssistantScratchDirectory({ paseoHome, directory: path.dirname(scratch) })).toBe(
      false,
    );
    const otherHome = path.join(root, "other-home");
    expect(isAssistantScratchDirectory({ paseoHome: otherHome, directory: gitScratch })).toBe(
      false,
    );
  });

  test("renames only untouched assistant defaults and is idempotent", async () => {
    await seedProject("scratch", scratch, "Assistant");
    await seedProject("git-scratch", gitScratch, "Assistant");
    await seedProject("scratch-custom", path.join(path.dirname(scratch), "c"), "My helper");
    await seedProject("user", userProject, "Assistant");
    await seedWorkspace("ws-scratch", scratch, "Assistant");
    await seedWorkspace("ws-scratch-custom", gitScratch, "Planning");
    await seedWorkspace("ws-user", userProject, "Assistant");
    await seedAgent("lead", "Assistant", { "paseo.role": "assistant" });
    await seedAgent("lead-renamed", "Release planning", { "paseo.role": "assistant" });
    await seedAgent("worker", "Assistant", {});

    expect(await migrate()).toEqual({ agents: 1, projects: 2, workspaces: 1 });

    expect((await projectRegistry.get("scratch"))?.customName).toBe("Lead agent");
    expect((await projectRegistry.get("git-scratch"))?.customName).toBe("Lead agent");
    expect((await projectRegistry.get("scratch-custom"))?.customName).toBe("My helper");
    expect((await projectRegistry.get("user"))?.customName).toBe("Assistant");
    expect((await workspaceRegistry.get("ws-scratch"))?.title).toBe("Lead agent");
    expect((await workspaceRegistry.get("ws-scratch"))?.updatedAt).toBe(NOW);
    expect((await workspaceRegistry.get("ws-scratch-custom"))?.title).toBe("Planning");
    expect((await workspaceRegistry.get("ws-user"))?.title).toBe("Assistant");
    expect((await agentStorage.get("lead"))?.title).toBe("Lead agent");
    expect((await agentStorage.get("lead-renamed"))?.title).toBe("Release planning");
    expect((await agentStorage.get("worker"))?.title).toBe("Assistant");

    expect(await migrate()).toEqual({ agents: 0, projects: 0, workspaces: 0 });
  });
});
