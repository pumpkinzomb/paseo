import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantWorkspaceDirectory,
  DefaultAssistantSelection,
  validateAssistantHandoff,
  selectAdvancedAssistantModel,
  configuredAssistantModel,
} from "./index.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-assistant-"));
  homes.push(home);
  const sessions = new Map<string, { agent: { id: string } }>();
  const selection = new DefaultAssistantSelection(home);
  let count = 0;
  const deps = {
    find: async (id: string) => sessions.get(id) ?? null,
    create: async () => {
      const value = { agent: { id: `agent-${++count}` } };
      sessions.set(value.agent.id, value);
      return value;
    },
  };
  return { home, sessions, selection, deps };
}
describe("default assistant selection", () => {
  it("restores the latest session after restart without creating another", async () => {
    const f = await fixture();
    const first = await f.selection.ensure({
      ...f.deps,
      requestId: "first",
      newSession: false,
    });
    const restored = await new DefaultAssistantSelection(f.home).ensure({
      ...f.deps,
      requestId: "reopen",
      newSession: false,
    });
    expect(restored).toEqual(first);
    expect(f.sessions.size).toBe(1);
  });
  it("new conversation replaces the target but keeps previous sessions", async () => {
    const f = await fixture();
    await f.selection.ensure({
      ...f.deps,
      requestId: "first",
      newSession: false,
    });
    const latest = await f.selection.ensure({
      ...f.deps,
      requestId: "new",
      newSession: true,
    });
    expect(
      await f.selection.ensure({
        ...f.deps,
        requestId: "reopen",
        newSession: false,
      }),
    ).toEqual(latest);
    expect(f.sessions.size).toBe(2);
    expect(
      await f.selection.ensure({
        ...f.deps,
        requestId: "first",
        newSession: false,
      }),
    ).toEqual(latest);
    await f.selection.remember("agent-1");
    expect(
      await f.selection.ensure({
        ...f.deps,
        requestId: "reopen-again",
        newSession: false,
      }),
    ).toEqual({ agent: { id: "agent-1" } });
  });
  it("deduplicates simultaneous startup and new-session retries", async () => {
    const f = await fixture();
    await Promise.all(
      ["one", "two"].map((requestId) =>
        f.selection.ensure({ ...f.deps, requestId, newSession: false }),
      ),
    );
    expect(f.sessions.size).toBe(1);
    await Promise.all(
      [1, 2].map(() => f.selection.ensure({ ...f.deps, requestId: "new", newSession: true })),
    );
    expect(f.sessions.size).toBe(2);
    await new DefaultAssistantSelection(f.home).ensure({
      ...f.deps,
      requestId: "new",
      newSession: true,
    });
    expect(f.sessions.size).toBe(2);
  });
  it("retains the old target on creation failure and permits retry", async () => {
    const f = await fixture();
    const first = await f.selection.ensure({
      ...f.deps,
      requestId: "first",
      newSession: false,
    });
    await expect(
      f.selection.ensure({
        ...f.deps,
        create: async () => {
          throw new Error("provider offline");
        },
        requestId: "new",
        newSession: true,
      }),
    ).rejects.toThrow("provider offline");
    expect(
      await f.selection.ensure({
        ...f.deps,
        requestId: "open",
        newSession: false,
      }),
    ).toEqual(first);
    expect(
      await f.selection.ensure({
        ...f.deps,
        requestId: "new",
        newSession: true,
      }),
    ).toEqual({
      agent: { id: "agent-2" },
    });
  });
  it("replaces missing targets, but a replay cannot resurrect a removed conversation", async () => {
    const f = await fixture();
    await f.selection.ensure({
      ...f.deps,
      requestId: "first",
      newSession: false,
    });
    f.sessions.delete("agent-1");
    await expect(
      f.selection.ensure({ ...f.deps, requestId: "first", newSession: true }),
    ).rejects.toThrow("archived or removed");
    expect(
      await f.selection.ensure({
        ...f.deps,
        requestId: "open",
        newSession: false,
      }),
    ).toEqual({
      agent: { id: "agent-2" },
    });
  });
});

describe("assistant scratch placement", () => {
  it("keeps ordinary daemon homes isolated and stable", () => {
    const input = {
      paseoHome: "/tmp/test-home",
      requestKey: "one",
      gitRoot: null,
    };
    const cwd = assistantWorkspaceDirectory(input);
    expect(cwd.startsWith("/tmp/test-home/assistant/")).toBe(true);
    expect(assistantWorkspaceDirectory(input)).toBe(cwd);
    expect(assistantWorkspaceDirectory({ ...input, requestKey: "two" })).not.toBe(cwd);
  });
  it("places repository-local dev homes beside the repository with independent host namespaces", () => {
    const input = {
      paseoHome: "/workspaces/paseo/.dev/home",
      requestKey: "one",
      gitRoot: "/workspaces/paseo",
    };
    const cwd = assistantWorkspaceDirectory(input);
    expect(cwd.startsWith("/workspaces/.paseo-assistant-workspaces/")).toBe(true);
    expect(
      assistantWorkspaceDirectory({
        ...input,
        paseoHome: "/workspaces/paseo/.dev/other",
      }),
    ).not.toBe(cwd);
  });
});

describe("reviewed assistant handoff", () => {
  const source = {
    id: "source",
    updatedAt: "v1",
    status: "idle",
    labels: { "paseo.role": "assistant" },
    pendingPermissions: [],
  };
  const handoff = {
    sourceAgentId: "source",
    sourceUpdatedAt: "v1",
    text: "Reviewed task and decisions",
  };
  it("accepts reviewed bounded text for the current idle assistant", () => {
    expect(() => validateAssistantHandoff(handoff, source, "source")).not.toThrow();
  });
  it("rejects stale, running, non-manager, non-current, and empty or oversized transfers", () => {
    for (const changed of [
      { ...source, status: "running" },
      { ...source, updatedAt: "v2" },
      { ...source, labels: {} },
      { ...source, pendingPermissions: [{}] },
      { ...source, activeTurn: {} },
      { ...source, backgroundWork: { count: 1 } },
    ]) {
      expect(() => validateAssistantHandoff(handoff, changed, "source")).toThrow();
    }
    expect(() => validateAssistantHandoff(handoff, source, "other")).toThrow();
    for (const text of [" ", "x".repeat(12001)]) {
      expect(() => validateAssistantHandoff({ ...handoff, text }, source, "source")).toThrow();
    }
  });
});

describe("logical assistant conversations", () => {
  it("appends successful handoffs, deduplicates retries, restores state, and keeps failures unchanged", async () => {
    const f = await fixture();
    const first = await f.selection.ensure({
      ...f.deps,
      requestId: "one",
      newSession: true,
    });
    const initial = await f.selection.getConversation({
      agentId: first.agent.id,
      find: f.deps.find,
    });
    const next = await f.selection.ensure({
      ...f.deps,
      requestId: "two",
      newSession: true,
      sourceAgentId: first.agent.id,
    });
    const conversation = await f.selection.getConversation({
      agentId: next.agent.id,
      find: f.deps.find,
    });
    expect(conversation?.logicalId).toBe(initial?.logicalId);
    expect(conversation?.segments.map((s) => s.agentId)).toEqual([first.agent.id, next.agent.id]);
    expect(conversation?.activeAgentId).toBe(next.agent.id);
    await f.selection.ensure({
      ...f.deps,
      requestId: "two",
      newSession: true,
      sourceAgentId: first.agent.id,
    });
    await expect(
      f.selection.ensure({
        ...f.deps,
        requestId: "failed",
        newSession: true,
        sourceAgentId: next.agent.id,
        create: async () => {
          throw new Error("creation failed");
        },
      }),
    ).rejects.toThrow("creation failed");
    const restored = new DefaultAssistantSelection(f.home);
    expect(
      await restored.getConversation({
        logicalId: initial?.logicalId,
        find: f.deps.find,
      }),
    ).toEqual(conversation);
    expect(
      (
        await restored.ensure({
          ...f.deps,
          requestId: "reopen",
          newSession: false,
        })
      ).agent.id,
    ).toBe(next.agent.id);
    await restored.remember(first.agent.id);
    expect(
      (
        await restored.getConversation({
          logicalId: initial?.logicalId,
          find: f.deps.find,
        })
      )?.activeAgentId,
    ).toBe(first.agent.id);
    const separate = await restored.ensure({
      ...f.deps,
      requestId: "new-topic",
      newSession: true,
    });
    expect(
      (
        await restored.getConversation({
          agentId: separate.agent.id,
          find: f.deps.find,
        })
      )?.logicalId,
    ).not.toBe(initial?.logicalId);
  });
  it("lazily migrates legacy state without losing its active session", async () => {
    const f = await fixture();
    f.sessions.set("legacy", { agent: { id: "legacy" } });
    await writeFile(
      join(f.home, "default-assistant.json"),
      JSON.stringify({ currentAgentId: "legacy", requests: {} }),
    );
    const migrated = await f.selection.getConversation({ find: f.deps.find });
    expect(migrated?.activeAgentId).toBe("legacy");
    expect(migrated?.segments.map((s) => s.agentId)).toEqual(["legacy"]);
    expect(
      await new DefaultAssistantSelection(f.home).getConversation({
        find: f.deps.find,
      }),
    ).toEqual(migrated);
  });
});

describe("advanced first assistant model", () => {
  it("uses live frontier metadata rather than model IDs or version numbers", () => {
    expect(
      selectAdvancedAssistantModel([
        {
          id: "newest-workhorse",
          description: "Latest workhorse for everyday work.",
        },
        {
          id: "changing-frontier-id",
          description: "Frontier intelligence for the most demanding work.",
          thinkingOptions: [{ id: "high" }, { id: "ultra" }],
        },
      ]),
    ).toEqual({ model: "changing-frontier-id", thinkingOptionId: "high" });
  });
  it("ignores old and unselectable models, and lets the provider choose when metadata is inconclusive", () => {
    expect(
      selectAdvancedAssistantModel([
        { id: "old", description: "Previous frontier model" },
        {
          id: "hidden",
          description: "Frontier intelligence",
          isSelectable: false,
        },
        { id: "regular", description: "General assistant" },
      ]),
    ).toBeUndefined();
    expect(
      selectAdvancedAssistantModel([{ id: "best", description: "Most capable model" }]),
    ).toEqual({ model: "best" });
  });
});

it("respects explicitly configured provider model defaults", () => {
  expect(
    configuredAssistantModel({
      options: { model: "custom-choice", model_reasoning_effort: "medium" },
    }),
  ).toEqual({ model: "custom-choice", thinkingOptionId: "medium" });
  expect(
    configuredAssistantModel({
      models: [{ id: "chosen-default", isDefault: true }],
    })?.model,
  ).toBe("chosen-default");
  expect(configuredAssistantModel({ enabled: true })).toBeUndefined();
});

describe("assistant conversation lifecycle", () => {
  it("archives every segment, falls back, restores without selecting, and deletes metadata", async () => {
    const f = await fixture();
    await f.selection.ensure({
      ...f.deps,
      requestId: "older",
      newSession: true,
    });
    const first = await f.selection.ensure({
      ...f.deps,
      requestId: "current",
      newSession: true,
    });
    const second = await f.selection.ensure({
      ...f.deps,
      requestId: "handoff",
      newSession: true,
      sourceAgentId: first.agent.id,
    });
    const calls: Array<{ ids: string[]; action: string }> = [];
    const apply = async (ids: string[], action: string) => {
      calls.push({ ids, action });
    };
    await f.selection.mutateConversation({
      agentId: second.agent.id,
      action: "archive",
      find: f.deps.find,
      apply,
    });
    expect(calls).toEqual([{ ids: [first.agent.id, second.agent.id], action: "archive" }]);
    await f.selection.remember(second.agent.id);
    expect(
      (
        await f.selection.ensure({
          ...f.deps,
          requestId: "reopen",
          newSession: false,
        })
      ).agent.id,
    ).toBe("agent-1");
    await expect(
      f.selection.ensure({ ...f.deps, requestId: "handoff", newSession: true }),
    ).rejects.toThrow("archived or removed");
    await f.selection.mutateConversation({
      agentId: first.agent.id,
      action: "restore",
      find: f.deps.find,
      apply,
    });
    expect(
      (
        await f.selection.getConversation({
          agentId: second.agent.id,
          find: f.deps.find,
        })
      )?.archivedAt,
    ).toBeNull();
    expect(
      (
        await f.selection.ensure({
          ...f.deps,
          requestId: "again",
          newSession: false,
        })
      ).agent.id,
    ).toBe("agent-1");
    const conversation = await f.selection.getConversation({
      agentId: first.agent.id,
      find: f.deps.find,
    });
    await f.selection.mutateConversation({
      agentId: second.agent.id,
      action: "delete",
      find: f.deps.find,
      apply: async (ids) => {
        for (const id of ids) f.sessions.delete(id);
      },
    });
    expect(
      await f.selection.getConversation({
        logicalId: conversation!.logicalId,
        find: f.deps.find,
      }),
    ).toBeNull();
    expect(f.sessions.size).toBe(1);
  });
  it("does not change selection on a failed mutation and handles the last conversation", async () => {
    const f = await fixture();
    const first = await f.selection.ensure({
      ...f.deps,
      requestId: "first",
      newSession: true,
    });
    await expect(
      f.selection.mutateConversation({
        agentId: first.agent.id,
        action: "archive",
        find: f.deps.find,
        apply: async () => {
          throw new Error("busy");
        },
      }),
    ).rejects.toThrow("busy");
    expect(
      await f.selection.ensure({
        ...f.deps,
        requestId: "reopen",
        newSession: false,
      }),
    ).toEqual(first);
    await f.selection.mutateConversation({
      agentId: first.agent.id,
      action: "archive",
      find: f.deps.find,
      apply: async () => {},
    });
    expect(
      (
        await f.selection.ensure({
          ...f.deps,
          requestId: "new",
          newSession: false,
        })
      ).agent.id,
    ).toBe("agent-2");
  });
});

describe("handoff source and reviewed context", () => {
  it("switches an older logical conversation without borrowing the latest conversation", async () => {
    const f = await fixture();
    const first = await f.selection.ensure({ ...f.deps, requestId: "old", newSession: true });
    const other = await f.selection.ensure({ ...f.deps, requestId: "latest", newSession: true });
    let source: string | null = null;
    const next = await f.selection.ensure({
      ...f.deps,
      requestId: "switch-old",
      newSession: true,
      sourceAgentId: first.agent.id,
      reviewedContext: "User-approved project decision",
      create: async (_key, previous) => {
        source = previous;
        return f.deps.create();
      },
    });
    expect(source).toBe(first.agent.id);
    const reloaded = new DefaultAssistantSelection(f.home);
    const conversation = await reloaded.getConversation({
      agentId: next.agent.id,
      find: f.deps.find,
    });
    expect(conversation?.segments.map((item) => item.agentId)).toEqual([
      first.agent.id,
      next.agent.id,
    ]);
    expect(conversation?.segments[1]?.reviewedContext).toBe("User-approved project decision");
    expect(
      (await reloaded.getConversation({ agentId: other.agent.id, find: f.deps.find }))?.segments,
    ).toHaveLength(1);
    await expect(
      reloaded.ensure({
        ...f.deps,
        requestId: "stale-segment",
        newSession: true,
        sourceAgentId: first.agent.id,
      }),
    ).rejects.toThrow("source assistant changed");
  });

  it("stores only the newly approved replacement, not old omitted context", async () => {
    const f = await fixture();
    const first = await f.selection.ensure({ ...f.deps, requestId: "a", newSession: true });
    const second = await f.selection.ensure({
      ...f.deps,
      requestId: "b",
      newSession: true,
      sourceAgentId: first.agent.id,
      reviewedContext: "Keep X and Y",
    });
    const third = await f.selection.ensure({
      ...f.deps,
      requestId: "c",
      newSession: true,
      sourceAgentId: second.agent.id,
      reviewedContext: "Keep Y only",
    });
    const conversation = await f.selection.getConversation({
      agentId: third.agent.id,
      find: f.deps.find,
    });
    expect(conversation?.segments[2]?.reviewedContext).toBe("Keep Y only");
    expect(conversation?.segments[0]?.reviewedContext).toBeUndefined();
  });
});
