import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DefaultAssistantSelection } from "./index.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture(crossWorkspace = false) {
  const home = await mkdtemp(join(tmpdir(), "paseo-group-delete-"));
  homes.push(home);
  const records = [
    { id: "a", workspaceId: "w" },
    { id: "b", workspaceId: crossWorkspace ? "other" : "w" },
    { id: "child", workspaceId: "w" },
    { id: "unrelated", workspaceId: "other" },
  ];
  const conversation = {
    logicalId: "logical",
    activeAgentId: "b",
    activeWorkspaceId: "w",
    segments: ["a", "b"].map((agentId) => ({
      agentId,
      workspaceId: "w",
      provider: "codex",
      model: null,
      createdAt: new Date().toISOString(),
    })),
  };
  const file = join(home, "default-assistant.json");
  await writeFile(
    file,
    JSON.stringify({
      currentAgentId: "b",
      requests: {},
      conversations: { logical: conversation },
      agentConversationIds: { a: "logical", b: "logical" },
    }),
  );
  const validate = vi.fn(async () => {});
  const apply = vi.fn(async () => {});
  const input = { workspaceId: "w", list: async () => records, validate, apply };
  return { selection: new DefaultAssistantSelection(home), input, records, file, validate, apply };
}
it("previews the complete exact group without changing records or logical metadata", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  expect(await f.selection.deleteWorkspaceSessions(f.input)).toEqual(["a", "b", "child"]);
  expect(f.apply).not.toHaveBeenCalled();
  expect(await readFile(f.file, "utf8")).toBe(before);
});
it("deletes every model segment and child in one batch, keeping other workspace records", async () => {
  const f = await fixture();
  expect(
    await f.selection.deleteWorkspaceSessions({
      ...f.input,
      expectedAgentIds: ["child", "b", "a"],
    }),
  ).toEqual(["a", "b", "child"]);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith(["a", "b", "child"]);
  const state = JSON.parse(await readFile(f.file, "utf8"));
  expect(state.conversations).toEqual({});
  expect(state.agentConversationIds).toEqual({});
  expect(state.currentAgentId).toBeNull();
});
it("rejects membership changes after confirmation without a partial batch", async () => {
  const f = await fixture();
  await expect(
    f.selection.deleteWorkspaceSessions({ ...f.input, expectedAgentIds: ["a", "b"] }),
  ).rejects.toThrow("changed");
  expect(f.apply).not.toHaveBeenCalled();
});
it("never expands deletion into another workspace to complete a logical conversation", async () => {
  const f = await fixture(true);
  await expect(f.selection.deleteWorkspaceSessions(f.input)).rejects.toThrow("another workspace");
  expect(f.apply).not.toHaveBeenCalled();
});
it("busy preflight preserves the entire group and metadata", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  f.validate.mockRejectedValue(new Error("running work"));
  await expect(
    f.selection.deleteWorkspaceSessions({ ...f.input, expectedAgentIds: ["a", "b", "child"] }),
  ).rejects.toThrow("running work");
  expect(f.apply).not.toHaveBeenCalled();
  expect(await readFile(f.file, "utf8")).toBe(before);
});
it("a failed apply cannot clear logical conversation metadata", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  f.apply.mockRejectedValue(new Error("close failed"));
  await expect(
    f.selection.deleteWorkspaceSessions({ ...f.input, expectedAgentIds: ["a", "b", "child"] }),
  ).rejects.toThrow("close failed");
  expect(await readFile(f.file, "utf8")).toBe(before);
});

it("includes only an explicit descendant scope in its confirmed batch", async () => {
  const f = await fixture(true);
  const ids = await f.selection.deleteWorkspaceSessions({
    ...f.input,
    workspaceIds: ["w", "other"],
  });
  expect(ids).toEqual(["a", "b", "child", "unrelated"]);
  await f.selection.deleteWorkspaceSessions({
    ...f.input,
    workspaceIds: ["w", "other"],
    expectedAgentIds: ids,
  });
  expect(f.apply).toHaveBeenCalledExactlyOnceWith(ids);
});
