import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { DaemonClient } from "../test-utils/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("project conversations register as assistants, survive deletion/new creation, and do not promote workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-assistant-workspace-"));
  execFileSync("git", ["init", "--quiet", root]);
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const project = await client.createWorkspace({
      source: { kind: "directory", path: root },
    });
    if (project.error || !project.workspace) throw new Error(project.error ?? "Missing workspace");
    const workspaceId = project.workspace.id;
    const first = await client.ensureDefaultAssistant({
      newSession: true,
      requestId: "project-first",
      workspaceId,
      modeId: "default",
      metadata: { origin: "direct-chat" },
    });
    expect(first.error).toBeNull();
    if (!first.agent || !first.conversation) throw new Error("Missing registered assistant");
    expect(first.agent.workspaceId).toBe(workspaceId);
    expect(first.agent.labels["paseo.role"]).toBe("assistant");
    expect(first.conversation.activeAgentId).toBe(first.agent.id);
    expect(first.conversation.activeWorkspaceId).toBe(workspaceId);
    expect(first.agent.status).toBe("idle");
    expect(first.agent.labels["paseo.parent-agent-id"]).toBeUndefined();
    expect(first.agent.metadata).toEqual({ origin: "direct-chat" });
    expect(first.agent.currentModeId).toBe("default");
    const replay = await client.ensureDefaultAssistant({
      newSession: true,
      requestId: "project-first",
      workspaceId,
      modeId: "default",
      metadata: { origin: "direct-chat" },
    });
    expect(replay.agent?.id).toBe(first.agent.id);
    const conflict = await client.ensureDefaultAssistant({
      newSession: true,
      requestId: "project-first",
    });
    expect(conflict.error).toContain("different settings");
    const switched = await client.ensureDefaultAssistant({
      newSession: true,
      requestId: "project-provider-switch",
      provider: "claude",
      handoff: {
        sourceAgentId: first.agent.id,
        sourceUpdatedAt: first.agent.updatedAt,
        text: "Reviewed project context",
      },
    });
    expect(switched.error).toBeNull();
    expect(switched.agent?.provider).toBe("claude");
    expect(switched.agent?.workspaceId).toBe(workspaceId);
    expect(switched.conversation?.logicalId).toBe(first.conversation.logicalId);
    expect(switched.conversation?.segments).toHaveLength(2);
    const worker = await client.createAgent({
      workspaceId,
      config: { provider: "codex", cwd: root },
    });
    expect(worker.labels["paseo.role"]).toBeUndefined();
    const deletion = await client.mutateAssistantConversation(first.agent.id, "delete");
    expect(deletion.error).toBeNull();
    const next = await client.ensureDefaultAssistant({
      newSession: true,
      requestId: "project-after-delete",
      workspaceId,
    });
    expect(next.error).toBeNull();
    expect(next.agent?.labels["paseo.role"]).toBe("assistant");
    expect(next.agent?.id).not.toBe(first.agent.id);
    expect(next.conversation?.activeWorkspaceId).toBe(workspaceId);
    const invalid = await client.ensureDefaultAssistant({ workspaceId });
    expect(invalid.error).toContain("requires a new assistant conversation");
    const missing = await client.ensureDefaultAssistant({
      newSession: true,
      requestId: "missing",
      workspaceId: "wks_0000000000000000",
    });
    expect(missing.error).toContain("unavailable");
    if (!next.agent) throw new Error("Missing next assistant");
    const handoff = await client.ensureDefaultAssistant({
      newSession: true,
      requestId: "conflicting-handoff",
      workspaceId,
      handoff: {
        sourceAgentId: next.agent.id,
        sourceUpdatedAt: next.agent.updatedAt,
        text: "reviewed",
      },
    });
    expect(handoff.error).toContain("must keep its source workspace");
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
