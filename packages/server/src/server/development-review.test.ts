import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm, mkdir, writeFile, copyFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pino from "pino";
import { DevelopmentReview } from "./development-review.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { requiredPermissionForInbound } from "./authorization/operation-permissions.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "development-review-")));
  roots.push(root);
  const source = path.join(root, "source"),
    task = path.join(root, "task");
  await mkdir(source);
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const git = (...args: string[]) => run(source, ...args);
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(path.join(source, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("worktree", "add", "--quiet", "-b", "task-review", task);
  const registryPath = path.join(root, "workspaces.json"),
    logger = pino({ level: "silent" });
  const registry = new FileBackedWorkspaceRegistry(registryPath, logger);
  for (const [id, cwd, parent] of [
    ["parent", root, undefined],
    ["source", source, undefined],
    ["task", task, "parent"],
    ["sibling", task, "other"],
  ] as const)
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: id,
        cwd,
        parentWorkspaceId: parent,
        projectId: "project",
        kind: id === "task" || id === "sibling" ? "worktree" : "directory",
        displayName: id,
        isPaseoOwnedWorktree: id === "task" || id === "sibling",
        createdAt: "now",
        updatedAt: "now",
      }),
    );
  const service = new DevelopmentReview(registry);
  const read = (
    scopeWorkspaceId: string,
    operation: "files" | "file" | "diff",
    file = "",
    evidenceId?: string,
  ) =>
    service.list("parent").then((scopes) =>
      service.read({
        scopeToken: scopes.find(
          (scope) => scope.workspaceId === scopeWorkspaceId && scope.evidenceId === evidenceId,
        )?.scopeToken,
        type: "workspace.development.read.request",
        workspaceId: "parent",
        scopeWorkspaceId,
        operation,
        path: file,
        evidenceId,
        requestId: "request",
      }),
    );
  return { root, source, task, base, git, run, registry, registryPath, logger, service, read };
}
it("requires registered same-host IDs, explicit links and managed descendants without granting writes", async () => {
  const f = await fixture();
  for (const id of [f.source, "foreign-host:source"])
    await expect(f.service.link("parent", id)).rejects.toThrow("Registered workspace");
  await expect(f.service.capture("parent", "task", "source", f.base)).rejects.toThrow("not linked");
  await f.service.link("parent", "source");
  await expect(f.service.capture("parent", "sibling", "source", f.base)).rejects.toThrow(
    "managed descendant",
  );
  await expect(f.read("sibling", "files")).rejects.toThrow("unavailable");
  await expect(f.read("source", "file", "../base.txt")).rejects.toThrow("inside");
  expect(requiredPermissionForInbound("workspace.development.link.request")).toBe(
    "workspace.manage",
  );
  expect(requiredPermissionForInbound("workspace.development.read.request")).toBe("workspace.read");
});
it("reads live new files and untracked diffs without moving conversation cwd", async () => {
  const f = await fixture();
  await f.service.link("parent", "source");
  await writeFile(path.join(f.source, "new.txt"), "new\n");
  expect((await f.read("source", "files")).entries?.map((entry) => entry.name)).toContain(
    "new.txt",
  );
  expect((await f.read("source", "file", "new.txt")).content).toBe("new\n");
  expect((await f.read("source", "diff")).diff).toContain("+new");
  expect((await f.registry.get("parent"))?.cwd).toBe(f.root);
  expect((await f.service.list("parent")).map((scope) => scope.workspaceId)).toEqual([
    "source",
    "task",
  ]);
});
it("retains exact committed content and nested unusual names after merge and branch/folder removal", async () => {
  const f = await fixture();
  await f.service.link("parent", "source");
  const contents = "changed\n\n  \t\n",
    name = "tab\tnewline\n.txt";
  await mkdir(path.join(f.task, "nested"));
  await writeFile(path.join(f.task, "nested", name), contents);
  f.run(f.task, "add", ".");
  f.run(f.task, "commit", "--quiet", "-m", "task");
  await expect(f.service.capture("parent", "task", "source")).rejects.toThrow("no pinned base");
  await expect(f.service.capture("parent", "task", "source", "main; echo unsafe")).rejects.toThrow(
    "full commit SHA",
  );
  const evidence = await f.service.capture("parent", "task", "source", f.base);
  expect(
    (await f.service.list("parent")).find((scope) => scope.evidenceId === evidence)?.status,
  ).toBe("committed");
  f.git("merge", "--quiet", "--no-ff", "task-review", "-m", "integrated");
  f.git("worktree", "remove", f.task);
  f.git("branch", "-d", "task-review");
  const service = new DevelopmentReview(new FileBackedWorkspaceRegistry(f.registryPath, f.logger));
  expect(
    (await service.list("parent")).find((scope) => scope.evidenceId === evidence)?.status,
  ).toBe("integrated");
  const request = {
    type: "workspace.development.read.request" as const,
    requestId: "read",
    workspaceId: "parent",
    scopeWorkspaceId: "task",
    evidenceId: evidence,
    scopeToken: (await service.list("parent")).find((scope) => scope.evidenceId === evidence)
      ?.scopeToken,
  };
  expect(
    (await service.read({ ...request, operation: "files" })).entries?.map((entry) => entry.path),
  ).toContain("nested");
  expect(
    (await service.read({ ...request, operation: "files", path: "nested" })).entries?.map(
      (entry) => entry.path,
    ),
  ).toContain(`nested/${name}`);
  expect(
    (await service.read({ ...request, operation: "file", path: `nested/${name}` })).content,
  ).toBe(contents);
  expect((await service.read({ ...request, operation: "diff" })).diff).toContain("+changed");
  await expect(
    service.read({ ...request, evidenceId: "stale", operation: "file", path: "base.txt" }),
  ).rejects.toThrow("unavailable");
});
it("reports missing source and rejects foreign repository capture", async () => {
  const f = await fixture();
  await f.service.link("parent", "source");
  await f.registry.update("task", (record) => ({ ...record, cwd: f.root }));
  await expect(f.service.capture("parent", "task", "source", f.base)).rejects.toThrow();
  await f.registry.remove("source");
  expect((await f.service.list("parent"))[0].status).toBe("unavailable");
  await expect(f.read("source", "files")).rejects.toThrow();
});
it("retains binary inventory alongside text while bounding aggregate untracked workloads", async () => {
  const f = await fixture();
  await f.service.link("parent", "source");
  await writeFile(path.join(f.source, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(f.source, "new-text.txt"), "visible text\n");
  const diff = await f.read("source", "diff");
  expect(diff.files?.find((entry) => entry.path === "binary")?.status).toBe("binary");
  expect(diff.diff).toContain("+visible text");
  await rm(path.join(f.source, "binary"));
  for (let index = 0; index < 101; index++)
    await writeFile(path.join(f.source, `new-${index}`), "new");
  await expect(f.read("source", "diff")).rejects.toThrow("100 untracked");
});

it("serves validated development scope RPCs through an isolated fake-provider daemon", async () => {
  const f = await fixture();
  const homeRoot = path.join(f.root, "daemon-home");
  const projects = path.join(homeRoot, ".paseo/projects");
  await mkdir(projects, { recursive: true });
  await copyFile(f.registryPath, path.join(projects, "workspaces.json"));
  const { createDaemonTestContext } = await import("./test-utils/daemon-test-context.js");
  const ctx = await createDaemonTestContext({
    paseoHomeRoot: homeRoot,
    staticDir: path.join(f.root, "static"),
    relayEnabled: false,
    mcpEnabled: false,
  });
  try {
    expect(ctx.client.getLastServerInfoMessage()?.features?.developmentReview).toBe(true);
    await ctx.client.linkDevelopmentSource("parent", "source");
    await writeFile(path.join(f.source, "rpc-new.txt"), "rpc new\n");
    const result = await ctx.client.readDevelopmentReview({
      workspaceId: "parent",
      scopeWorkspaceId: "source",
      scopeToken: (
        await ctx.client.readDevelopmentReview({ workspaceId: "parent", operation: "list" })
      ).scopes.find((scope) => scope.workspaceId === "source")?.scopeToken,
      operation: "files",
    });
    expect(result.entries?.map((entry) => entry.name)).toContain("rpc-new.txt");
    await expect(
      ctx.client.readDevelopmentReview({
        workspaceId: "parent",
        scopeWorkspaceId: "sibling",
        operation: "files",
      }),
    ).rejects.toThrow("unavailable");
  } finally {
    await ctx.cleanup();
  }
});

it("pins the creation base before main moves and retains earlier captures", async () => {
  const f = await fixture();
  const { createWorktree } = await import("../utils/worktree.js");
  const created = await createWorktree({
    cwd: f.source,
    worktreeSlug: "new-managed",
    worktreePath: path.join(f.root, "new-managed"),
    source: { kind: "branch-off", baseBranch: "main", branchName: "new-managed" },
  });
  await f.registry.update("task", (record) => ({ ...record, cwd: created.worktreePath }));
  await f.service.link("parent", "source");
  await writeFile(path.join(f.source, "later.txt"), "later main\n");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "main moved");
  await writeFile(path.join(created.worktreePath, "review.txt"), "first\n");
  f.run(created.worktreePath, "add", ".");
  f.run(created.worktreePath, "commit", "--quiet", "-m", "first");
  const first = await f.service.capture("parent", "task", "source");
  expect((await f.registry.get("task"))?.developmentEvidence?.baseSha).toBe(f.base);
  await writeFile(path.join(created.worktreePath, "review.txt"), "second\n");
  f.run(created.worktreePath, "add", ".");
  f.run(created.worktreePath, "commit", "--quiet", "-m", "second");
  const second = await f.service.capture("parent", "task", "source");
  expect(first).not.toBe(second);
  expect((await f.read("task", "file", "review.txt", first)).content).toBe("first\n");
  expect((await f.read("task", "file", "review.txt", second)).content).toBe("second\n");
});

it("rejects stale scope tokens and a repository replaced at the same registered path", async () => {
  const f = await fixture();
  await f.service.link("parent", "source");
  const scopeToken = (await f.service.list("parent")).find(
    (scope) => scope.workspaceId === "source",
  )?.scopeToken;
  const request = {
    type: "workspace.development.read.request" as const,
    workspaceId: "parent",
    scopeWorkspaceId: "source",
    operation: "files" as const,
    requestId: "read",
    scopeToken,
  };
  await expect(f.service.read({ ...request, scopeToken: "stale" })).rejects.toThrow(
    "scope changed",
  );
  await rename(f.source, path.join(f.root, "retained-source"));
  await mkdir(f.source);
  f.git("init", "--quiet", "--initial-branch=main");
  await expect(f.service.read(request)).rejects.toThrow("identity changed");
});

it("capture idempotency includes the retained source identity, base and head", async () => {
  const f = await fixture();
  const source = await f.registry.get("source");
  if (!source) throw new Error("fixture source missing");
  await f.registry.upsert({ ...source, workspaceId: "source-alias" });
  await f.service.link("parent", "source");
  await f.service.link("parent", "source-alias");
  const first = await f.service.capture("parent", "task", "source", f.base);
  const second = await f.service.capture("parent", "task", "source-alias", f.base);
  expect(first).not.toBe(second);
  expect(await f.service.capture("parent", "task", "source-alias", f.base)).toBe(second);
  expect((await f.registry.get("task"))?.developmentEvidence?.sourceWorkspaceId).toBe(
    "source-alias",
  );
  expect((await f.registry.get("task"))?.developmentEvidenceHistory?.[0].id).toBe(first);
});
