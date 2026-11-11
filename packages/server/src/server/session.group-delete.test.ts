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
  const archive = vi.fn(async () => true);
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
    workspaceRegistry: { get: async () => ({}), archive },
    emitForSource: emit,
  });
  const invoke = () =>
    Reflect.get(session, "handleWorkspaceSessionsDelete").call(session, {
      type: "workspace.sessions.delete.request",
      requestId: "request",
      workspaceId: "w",
      expectedAgentIds: ["a", "b"],
    });
  return { records, archive, emit, remove, invoke, owner };
}
it("group handler hides only metadata after a successful exact-scope deletion", async () => {
  const f = await fixture();
  await f.invoke();
  expect(f.records.has("other")).toBe(true);
  expect(f.archive).toHaveBeenCalledWith("w", expect.any(String));
  expect(f.emit.mock.calls[0][0].payload).toMatchObject({ agentIds: ["a", "b"], error: null });
});
it("group handler returns already-deleted IDs if workspace metadata cleanup fails", async () => {
  const f = await fixture();
  f.archive.mockRejectedValue(new Error("Disk full"));
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
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.records.has("b")).toBe(true);
  expect(f.emit.mock.calls[0][0].payload).toMatchObject({
    agentIds: ["a"],
    error: expect.stringContaining("partially completed"),
  });
});
