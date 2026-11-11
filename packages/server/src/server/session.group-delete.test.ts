import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Session } from "./session.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-group-handler-"));
  homes.push(home);
  const records = new Map([
    ["a", { id: "a", workspaceId: "w" }],
    ["b", { id: "b", workspaceId: "w" }],
    ["other", { id: "other", workspaceId: "other" }],
  ]);
  const workspaces: { workspaceId: string; parentWorkspaceId: string | null }[] = [
    { workspaceId: "w", parentWorkspaceId: null },
    { workspaceId: "other", parentWorkspaceId: null },
  ];
  const update = vi.fn(async (_id: string, _apply: (record: object) => object) => true);
  const emit = vi.fn();
  const remove = vi.fn(async (ids: string[]) => {
    for (const id of ids) records.delete(id);
  });
  const owner = {
    validateAssistantConversationMutation: vi.fn(async () => {}),
    mutateAssistantConversationRecords: remove,
    withWorkspaceSessionDeletion: vi.fn(
      async (_workspaceId: string, action: () => Promise<unknown>) => action(),
    ),
  };
  const session = Object.create(Session.prototype);
  Object.assign(session, {
    agentManager: owner,
    paseoHome: home,
    agentStorage: { listAll: async () => [...records.values()] },
    workspaceRegistry: { get: async () => ({}), listAll: async () => workspaces, update },
    emitForSource: emit,
  });
  const invoke = (overrides: object = {}) =>
    Reflect.get(session, "handleWorkspaceSessionsDelete").call(session, {
      type: "workspace.sessions.delete.request",
      requestId: "request",
      workspaceId: "w",
      expectedAgentIds: ["a", "b"],
      ...overrides,
    });
  return { records, workspaces, update, emit, remove, invoke, owner };
}
it("group handler hides only metadata after a successful exact-scope deletion", async () => {
  const f = await fixture();
  await f.invoke();
  expect(f.records.has("other")).toBe(true);
  expect(f.update).toHaveBeenCalledWith("w", expect.any(Function));
  const apply = f.update.mock.calls[0][1] as unknown as (value: object) => {
    archivedAt: string;
    metadata: { sessionRecordsDeletedAt: string; retained: boolean };
  };
  const updated = apply({ metadata: { retained: true } });
  expect(updated.metadata.retained).toBe(true);
  expect(updated.metadata.sessionRecordsDeletedAt).toBe(updated.archivedAt);
  expect(f.emit.mock.calls[0][0].payload).toMatchObject({
    agentIds: ["a", "b"],
    error: null,
  });
});
it("group handler returns already-deleted IDs if workspace metadata cleanup fails", async () => {
  const f = await fixture();
  f.update.mockRejectedValue(new Error("Disk full"));
  await f.invoke();
  expect(f.emit.mock.calls[0][0].payload).toMatchObject({
    agentIds: ["a", "b"],
    error: expect.stringContaining("partially completed"),
  });
});
it("group handler preserves the row and reports a partial record failure accurately", async () => {
  const f = await fixture();
  f.remove.mockImplementation(async () => {
    f.records.delete("a");
    throw new Error("Disk full");
  });
  await f.invoke();
  expect(f.update).not.toHaveBeenCalled();
  expect(f.records.has("b")).toBe(true);
  expect(f.emit.mock.calls[0][0].payload).toMatchObject({
    agentIds: ["a"],
    error: expect.stringContaining("partially completed"),
  });
});

it("keeps completed children reviewable until their records are explicitly deleted", async () => {
  const session = Object.create(Session.prototype);
  const child = (workspaceId: string, metadata: object = {}) => ({
    workspaceId,
    parentWorkspaceId: "parent",
    projectId: "removed-project",
    archivedAt: "2026-11-11T00:00:00.000Z",
    createdAt: "2026-11-10T00:00:00.000Z",
    name: workspaceId,
    metadata,
  });
  Object.assign(session, {
    workspaceRegistry: {
      listAll: async () => [
        child("retained"),
        child("deleted", {
          sessionRecordsDeletedAt: "2026-11-11T00:00:00.000Z",
        }),
        { ...child("unrelated"), parentWorkspaceId: "other" },
      ],
    },
    agentStorage: {
      listByWorkspaces: async () => [
        {
          id: "agent",
          workspaceId: "retained",
          createdAt: "2026-11-10T00:00:00.000Z",
        },
      ],
    },
  });
  const result = await Reflect.get(session, "describeArchivedSubSessions").call(session, "parent");
  expect(result.archivedSubSessions).toEqual([
    expect.objectContaining({ workspaceId: "retained", agentId: "agent" }),
  ]);
});

it("deletes explicitly confirmed descendants and keeps a sibling workspace", async () => {
  const f = await fixture();
  f.workspaces.push({ workspaceId: "child", parentWorkspaceId: "w" });
  f.workspaces.push({ workspaceId: "grandchild", parentWorkspaceId: "child" });
  f.records.set("c", { id: "c", workspaceId: "child" });
  f.records.set("g", { id: "g", workspaceId: "grandchild" });
  await f.invoke({
    expectedAgentIds: ["a", "b", "c", "g"],
    expectedWorkspaceIds: ["w", "child", "grandchild"],
  });
  expect(f.remove).toHaveBeenCalledExactlyOnceWith(["a", "b", "c", "g"], "delete", null, [
    "child",
    "grandchild",
    "w",
  ]);
  expect([...f.records.keys()]).toEqual(["other"]);
  expect(f.update.mock.calls.map(([id]) => id)).toEqual(["child", "grandchild", "w"]);
});
it("rejects an added empty descendant after preview before deleting records", async () => {
  const f = await fixture();
  f.workspaces.push({ workspaceId: "new-empty", parentWorkspaceId: "w" });
  await f.invoke({ expectedWorkspaceIds: ["w"] });
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.emit.mock.calls[0][0].payload.error).toContain("changed");
});
it("keeps legacy clients scoped to the exact workspace", async () => {
  const f = await fixture();
  f.workspaces.push({ workspaceId: "child", parentWorkspaceId: "w" });
  f.records.set("c", { id: "c", workspaceId: "child" });
  await f.invoke();
  expect(f.records.has("c")).toBe(true);
  expect(f.update.mock.calls.map(([id]) => id)).toEqual(["w"]);
});
it("rejects busy children before record mutation", async () => {
  const f = await fixture();
  f.workspaces.push({ workspaceId: "child", parentWorkspaceId: "w" });
  f.records.set("c", { id: "c", workspaceId: "child" });
  f.owner.validateAssistantConversationMutation.mockRejectedValue(new Error("running work"));
  await f.invoke({ expectedAgentIds: ["a", "b", "c"], expectedWorkspaceIds: ["w", "child"] });
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});
it("rejects a parent cycle without deleting records", async () => {
  const f = await fixture();
  f.workspaces[0]!.parentWorkspaceId = "child";
  f.workspaces.push({ workspaceId: "child", parentWorkspaceId: "w" });
  await f.invoke({ type: "workspace.sessions.delete.inspect.request", includeDescendants: true });
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.emit.mock.calls[0][0].payload.error).toContain("cyclic");
});
