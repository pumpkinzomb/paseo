import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Session } from "./session.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-project-delete-"));
  homes.push(home);
  const workspaces = [
    {
      workspaceId: "root",
      projectId: "project",
      parentWorkspaceId: null as string | null,
      archivedAt: null as string | null,
    },
    {
      workspaceId: "archived",
      projectId: "project",
      parentWorkspaceId: null,
      archivedAt: "2026-01-01",
    },
    {
      workspaceId: "child",
      projectId: "other",
      parentWorkspaceId: "root",
      archivedAt: "2026-01-01",
    },
    { workspaceId: "sibling", projectId: "other", parentWorkspaceId: null, archivedAt: null },
  ];
  const records = new Map(
    workspaces.map((workspace) => [
      workspace.workspaceId,
      { id: workspace.workspaceId, workspaceId: workspace.workspaceId },
    ]),
  );
  const remove = vi.fn(async (ids: string[]) => {
    for (const id of ids) records.delete(id);
  });
  const validate = vi.fn(async () => {});
  const validateNative = vi.fn(async (_ids: string[]) => {});
  const update = vi.fn(async (_id: string, _apply: (record: object) => object) => true);
  const session = Object.create(Session.prototype);
  Object.assign(session, {
    paseoHome: home,
    agentStorage: { listAll: async () => [...records.values()] },
    workspaceRegistry: { listAll: async () => workspaces, update },
    agentManager: {
      mutateAssistantConversationRecords: remove,
      validateAssistantConversationMutation: validate,
      validateNativeSessionDeletion: validateNative,
      withWorkspaceSessionDeletion: async (_id: string, action: () => Promise<unknown>) => action(),
    },
  });
  const inspect = () =>
    Reflect.get(session, "resolveProjectRemovalScope").call(session, "project") as Promise<
      string[]
    >;
  const execute = (
    confirmed = {
      workspaceIds: ["archived", "child", "root"],
      agentIds: ["archived", "child", "root"],
    },
    deleteNativeSessions = false,
  ) =>
    Reflect.get(session, "removeProjectSessionRecords").call(
      session,
      "project",
      confirmed,
      deleteNativeSessions,
    );
  return {
    home,
    session,
    workspaces,
    records,
    remove,
    validate,
    validateNative,
    update,
    inspect,
    execute,
  };
}
it("explicit project removal includes archived records and linked descendants, preserving unrelated siblings", async () => {
  const f = await fixture();
  expect(await f.inspect()).toEqual(["archived", "child", "root"]);
  await f.execute();
  expect([...f.records.keys()]).toEqual(["sibling"]);
  expect(f.update.mock.calls.map(([id]) => id)).toEqual(["archived", "child", "root"]);
  expect(f.remove).toHaveBeenCalledWith(["archived", "child", "root"], "delete", null, [
    "archived",
    "child",
    "root",
  ]);
});
it("new empty descendants invalidate the confirmed project removal scope", async () => {
  const f = await fixture();
  f.workspaces.push({
    workspaceId: "empty-child",
    projectId: "other",
    parentWorkspaceId: "root",
    archivedAt: null,
  });
  await expect(f.execute()).rejects.toThrow("groups changed");
  expect(f.remove).not.toHaveBeenCalled();
});
it("busy children block all project record deletion", async () => {
  const f = await fixture();
  f.validate.mockRejectedValueOnce(new Error("Child busy"));
  await expect(f.execute()).rejects.toThrow("Child busy");
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});
it("cyclic parent relationships block project deletion", async () => {
  const f = await fixture();
  f.workspaces[0]!.parentWorkspaceId = "child";
  await expect(f.execute()).rejects.toThrow("cyclic");
  expect(f.remove).not.toHaveBeenCalled();
});
it("changed record inventory blocks deletion", async () => {
  const f = await fixture();
  f.records.set("new", { id: "new", workspaceId: "root" });
  await expect(f.execute()).rejects.toThrow();
  expect(f.remove).not.toHaveBeenCalled();
});
it("scope is checked again under workspace locks", async () => {
  const f = await fixture();
  f.validate.mockImplementationOnce(async () => {
    f.workspaces[2]!.parentWorkspaceId = null;
  });
  await expect(f.execute()).rejects.toThrow("groups changed");
  expect(f.remove).not.toHaveBeenCalled();
});
it("post-mutation scope changes report partial deletion rather than a safe retry", async () => {
  const f = await fixture();
  f.remove.mockImplementationOnce(async (ids: string[]) => {
    for (const id of ids) f.records.delete(id);
    f.workspaces.push({
      workspaceId: "new-child",
      projectId: "other",
      parentWorkspaceId: "root",
      archivedAt: null,
    });
  });
  await expect(f.execute()).rejects.toThrow("partially completed");
  expect(f.update).not.toHaveBeenCalled();
});
it("confirmed empty project removes no unrelated sessions", async () => {
  const f = await fixture();
  f.workspaces.splice(0, 3);
  await f.execute({ workspaceIds: [], agentIds: [] });
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});

it("project removal preflights original session ownership before requesting native deletion", async () => {
  const f = await fixture();
  await f.execute(undefined, true);
  expect(f.validateNative).toHaveBeenCalledWith(["archived", "child", "root"]);
  expect(f.remove).toHaveBeenCalledWith(
    ["archived", "child", "root"],
    "delete",
    null,
    ["archived", "child", "root"],
    true,
  );
});
it("unsupported/shared originals block project removal without changing records", async () => {
  const f = await fixture();
  f.validateNative.mockRejectedValue(Error("Original is shared with another conversation"));
  await expect(f.execute(undefined, true)).rejects.toThrow("shared");
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
  expect(f.records.size).toBe(4);
});
it("project metadata removal never deletes protected source, installed-app, auth or symlink targets", async () => {
  const f = await fixture();
  const protectedRoot = join(f.home, "protected");
  await mkdir(join(protectedRoot, "Paseo.app"), { recursive: true });
  const paths = [
    join(protectedRoot, "source.ts"),
    join(protectedRoot, "auth.json"),
    join(protectedRoot, "Paseo.app", "bundle"),
  ];
  for (const p of paths) await writeFile(p, "must survive");
  await symlink(protectedRoot, join(f.home, "project-alias"));
  await f.execute(undefined, true);
  for (const p of paths) expect(await readFile(p, "utf8")).toBe("must survive");
  expect(await readFile(join(f.home, "project-alias", "source.ts"), "utf8")).toBe("must survive");
});
