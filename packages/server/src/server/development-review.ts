import { parseDiff } from "./utils/diff-highlighter.js";
import { createHash, randomUUID } from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import type {
  DevelopmentReviewReadRequest,
  DevelopmentReviewScope,
} from "@getpaseo/protocol/messages";
import type { WorkspaceRegistry, PersistedWorkspaceRecord } from "./workspace-registry.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import { listDirectoryEntries, readExplorerFile } from "./file-explorer/service.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function reviewFiles(diff: string): import("@getpaseo/protocol/messages").ParsedDiffFile[] {
  return diff
    .split(/^diff --git /m)
    .filter((section) => section.trim().length > 0)
    .flatMap((section) => {
      const file = parseDiff(`diff --git ${section}`)[0];
      if (!file) return [];
      return [
        {
          ...file,
          status: /^(Binary files .+ differ|GIT binary patch)$/m.test(section) ? "binary" : "ok",
        },
      ];
    });
}
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommand(["--literal-pathspecs", ...args], {
    cwd,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (result.truncated || result.exitCode !== 0)
    throw new Error("Development repository or commit unavailable");
  return result.stdout;
}
async function gitControl(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).trim();
}
function boundedText(value: string): string {
  if (Buffer.byteLength(value) > 4 * 1024 * 1024 || value.includes("\0"))
    throw new Error("Development review text is binary or exceeds the 4 MiB limit");
  return value;
}
async function repository(workspace: PersistedWorkspaceRecord): Promise<string> {
  const canonical = await realpath(workspace.cwd);
  if (canonical !== workspace.cwd) throw new Error("Development source path changed");
  const top = await realpath(await gitControl(canonical, ["rev-parse", "--show-toplevel"]));
  if (top !== canonical) throw new Error("Development source must be a registered repository root");
  const common = await realpath(
    await gitControl(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const info = await lstat(common);
  return `${common}:${info.dev}:${info.ino}`;
}
async function commit(cwd: string, sha: string): Promise<string> {
  if (!SHA.test(sha)) throw new Error("A full commit SHA is required");
  if ((await gitControl(cwd, ["rev-parse", "--verify", `${sha}^{commit}`])) !== sha)
    throw new Error("Commit evidence changed");
  return sha;
}
function relativeFile(value = ""): string {
  if (path.isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/).includes(".."))
    throw new Error("Review path must stay inside the selected source");
  return value;
}

async function liveDiff(cwd: string): Promise<string> {
  let diff = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const names = untracked.split("\0").filter(Boolean);
  if (names.length > 100) throw new Error("Development diff exceeds the 100 untracked file limit");
  boundedText(diff);
  let processedBytes = Buffer.byteLength(diff);
  for (const name of names) {
    relativeFile(name);
    // Reuse file service containment before invoking Git on an untracked entry.
    const info = await lstat(path.join(cwd, name));
    if (!info.isFile()) continue;
    processedBytes += info.size;
    if (processedBytes > 4 * 1024 * 1024)
      throw new Error("Aggregate development text exceeds the 4 MiB limit");
    const entry = await readExplorerFile({ root: cwd, relativePath: name });
    if (entry.kind === "text") boundedText(entry.content ?? "");
    const result = await runGitCommand(
      ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", name],
      { cwd: cwd, maxOutputBytes: 4 * 1024 * 1024, acceptExitCodes: [0, 1] },
    );
    if (result.truncated || (result.exitCode !== 0 && result.exitCode !== 1))
      throw new Error("Untracked diff unavailable");
    diff = boundedText(diff + `\n${result.stdout}`);
  }
  return diff;
}

/** Read-only associations never participate in file writes, terminals or agent cwd resolution. */
export class DevelopmentReview {
  constructor(private readonly workspaces: WorkspaceRegistry) {}
  private async get(id: string): Promise<PersistedWorkspaceRecord> {
    const workspace = await this.workspaces.get(id);
    if (!workspace) throw new Error("Registered workspace unavailable on this host");
    return workspace;
  }
  private async descendant(parentId: string, child: PersistedWorkspaceRecord): Promise<boolean> {
    const seen = new Set<string>();
    let current = child;
    while (current.parentWorkspaceId && !seen.has(current.workspaceId)) {
      seen.add(current.workspaceId);
      if (current.parentWorkspaceId === parentId) return true;
      const next = await this.workspaces.get(current.parentWorkspaceId);
      if (!next) return false;
      current = next;
    }
    return false;
  }
  async link(parentId: string, sourceId: string): Promise<void> {
    await this.get(parentId);
    const source = await this.get(sourceId);
    if (parentId === sourceId || source.archivedAt || source.untrustedSource)
      throw new Error("Select an active development source");
    const identity = await repository(source);
    await this.workspaces.update(parentId, (record) => ({
      ...record,
      developmentSourceIdentities: {
        ...record.developmentSourceIdentities,
        [sourceId]: identity,
      },
      developmentSourceIds: [...new Set([...(record.developmentSourceIds ?? []), sourceId])],
    }));
  }
  private async relatedSource(
    parentId: string,
    source: PersistedWorkspaceRecord,
  ): Promise<boolean> {
    if (source.untrustedSource) return false;
    if (source.workspaceId === parentId) return true;
    if (await this.descendant(parentId, source)) return true;
    for (const child of await this.workspaces.listAll()) {
      if (
        !child.isPaseoOwnedWorktree ||
        child.untrustedSource ||
        child.mainRepoRoot !== source.cwd ||
        !(await this.descendant(parentId, child))
      )
        continue;
      try {
        if ((await repository(child)) === (await repository(source))) return true;
      } catch {
        /* Missing placement cannot establish a new association. */
      }
    }
    return false;
  }
  private async linked(parentId: string, sourceId: string): Promise<PersistedWorkspaceRecord> {
    const parent = await this.get(parentId);
    const source = await this.get(sourceId);
    if (parent.developmentSourceIds?.includes(sourceId)) {
      if (parent.developmentSourceIdentities?.[sourceId] !== (await repository(source)))
        throw new Error("Linked repository identity changed; review and link the source again");
    } else if (!(await this.relatedSource(parentId, source)))
      throw new Error("Source is not linked to this conversation");
    return source;
  }
  /** Called only inside admitted workspace creation; list/read discovery never writes. */
  async recordDelegation(taskId: string, sourceCwd?: string): Promise<void> {
    const task = await this.get(taskId);
    if (!task.parentWorkspaceId || !task.isPaseoOwnedWorktree || task.untrustedSource) return;
    let identity: string;
    try {
      identity = await repository(task);
    } catch {
      return;
    }
    const ancestors: string[] = [];
    let parentId: string | undefined = task.parentWorkspaceId;
    while (parentId && !ancestors.includes(parentId)) {
      ancestors.push(parentId);
      parentId = (await this.get(parentId)).parentWorkspaceId;
    }
    for (const source of await this.workspaces.listActive()) {
      if (
        source.untrustedSource ||
        source.workspaceId === taskId ||
        ![sourceCwd, task.mainRepoRoot].includes(source.cwd)
      )
        continue;
      try {
        if ((await repository(source)) !== identity) continue;
      } catch {
        continue;
      }
      for (const ancestor of ancestors) {
        if (ancestor === source.workspaceId) continue;
        await this.workspaces.update(ancestor, (parent) => {
          if (parent.developmentSourceIds?.includes(source.workspaceId)) return parent;
          return {
            ...parent,
            developmentSourceIds: [...(parent.developmentSourceIds ?? []), source.workspaceId],
            developmentSourceIdentities: {
              ...parent.developmentSourceIdentities,
              [source.workspaceId]: identity,
            },
          };
        });
      }
    }
  }
  private async liveSource(parentId: string, workspace: PersistedWorkspaceRecord): Promise<string> {
    const parent = await this.get(parentId);
    if (parent.developmentSourceIds?.includes(workspace.workspaceId)) return workspace.workspaceId;
    if (!(await this.descendant(parentId, workspace)) || workspace.untrustedSource)
      throw new Error("Selected development scope unavailable");
    const identity = await repository(workspace);
    const records = await this.workspaces.listAll();
    const candidates = [
      ...(parent.developmentSourceIds ?? []),
      ...records
        .filter((record) => record.cwd === workspace.mainRepoRoot)
        .map((record) => record.workspaceId),
    ];
    for (const id of candidates) {
      try {
        if ((await repository(await this.linked(parentId, id))) === identity) return id;
      } catch {
        /* Do not use an unrelated or replaced source. */
      }
    }
    return workspace.workspaceId;
  }
  async capture(
    parentId: string,
    taskId: string,
    sourceId: string,
    reviewedBase?: string,
  ): Promise<string> {
    const task = await this.get(taskId);
    const source = await this.linked(parentId, sourceId);
    if (!task.isPaseoOwnedWorktree || !(await this.descendant(parentId, task)))
      throw new Error("Task is not a managed descendant of this conversation");
    const identity = await repository(source);
    if (identity !== (await repository(task)))
      throw new Error("Task belongs to another repository");
    const marker = await readPaseoWorktreeMetadata(task.cwd);
    const base = task.developmentEvidence?.baseSha ?? marker?.reviewBaseSha ?? reviewedBase;
    if (!base)
      throw new Error("Legacy task has no pinned base; explicit reviewed capture required");
    const baseSha = await commit(task.cwd, base);
    const headSha = await commit(
      task.cwd,
      await gitControl(task.cwd, ["rev-parse", "--verify", "HEAD^{commit}"]),
    );
    await git(task.cwd, ["merge-base", "--is-ancestor", baseSha, headSha]);
    const parent = await this.get(parentId);
    if (sourceId !== parentId && !parent.developmentSourceIds?.includes(sourceId))
      await this.link(parentId, sourceId);
    const existing = task.developmentEvidence;
    if (
      existing?.headSha === headSha &&
      existing.sourceWorkspaceId === sourceId &&
      existing.repository === identity &&
      existing.baseSha === baseSha
    )
      return existing.id;
    const id = randomUUID();
    await this.workspaces.update(taskId, (record) => ({
      ...record,
      developmentEvidenceHistory: [
        ...(record.developmentEvidenceHistory ?? []),
        ...(record.developmentEvidence ? [record.developmentEvidence] : []),
      ],
      developmentEvidence: {
        id,
        sourceWorkspaceId: sourceId,
        repository: identity,
        baseSha,
        headSha,
        capturedAt: new Date().toISOString(),
      },
    }));
    return id;
  }
  private async scope(
    parentId: string,
    workspace: PersistedWorkspaceRecord,
    sourceId: string,
    pinned = true,
  ): Promise<DevelopmentReviewScope> {
    const evidence = pinned ? workspace.developmentEvidence : undefined;
    const parent = await this.get(parentId);
    const token = (identity: string | undefined) =>
      createHash("sha256")
        .update(
          JSON.stringify([sourceId, identity, workspace.workspaceId, workspace.cwd, evidence?.id]),
        )
        .digest("hex");
    const scopeToken = token(parent.developmentSourceIdentities?.[sourceId]);
    const scope: DevelopmentReviewScope = {
      scopeToken,
      workspaceId: workspace.workspaceId,
      sourceWorkspaceId: sourceId,
      label: workspace.title ?? workspace.displayName,
      path: workspace.cwd,
      branch: workspace.branch,
      status: "live",
      ...(evidence
        ? { evidenceId: evidence.id, baseSha: evidence.baseSha, headSha: evidence.headSha }
        : {}),
    };
    try {
      const source = await this.linked(parentId, sourceId);
      const identity = await repository(source);
      scope.scopeToken = token(parent.developmentSourceIdentities?.[sourceId] ?? identity);
      if (evidence) {
        if (evidence.sourceWorkspaceId !== sourceId || evidence.repository !== identity)
          throw new Error("Repository identity changed");
        await commit(source.cwd, evidence.baseSha);
        await commit(source.cwd, evidence.headSha);
        const integrated = await runGitCommand(
          ["merge-base", "--is-ancestor", evidence.headSha, "HEAD"],
          { cwd: source.cwd, acceptExitCodes: [0, 1] },
        );
        scope.status = integrated.exitCode === 0 ? "integrated" : "committed";
      } else {
        if ((await repository(workspace)) !== identity)
          throw new Error("Repository identity changed");
        const branch = await runGitCommand(["symbolic-ref", "--short", "-q", "HEAD"], {
          cwd: workspace.cwd,
          acceptExitCodes: [0, 1],
        });
        scope.branch = branch.stdout.trim() || null;
      }
    } catch (error) {
      scope.status = "unavailable";
      scope.error = error instanceof Error ? error.message : String(error);
    }
    return scope;
  }
  private async retainedSources(
    parentId: string,
    record: PersistedWorkspaceRecord,
    records: PersistedWorkspaceRecord[],
  ): Promise<string[]> {
    if (!record.isPaseoOwnedWorktree || !record.mainRepoRoot) return [];
    const result = [];
    for (const source of records) {
      if (
        source.workspaceId !== parentId &&
        source.cwd === record.mainRepoRoot &&
        (await this.relatedSource(parentId, source))
      )
        result.push(source.workspaceId);
    }
    return result;
  }
  async list(parentId: string): Promise<DevelopmentReviewScope[]> {
    const parent = await this.get(parentId);
    const records = await this.workspaces.listAll();
    const ids = new Set(parent.developmentSourceIds ?? []);
    const related: PersistedWorkspaceRecord[] = [];
    for (const record of records) {
      if (record.untrustedSource || !(await this.descendant(parentId, record))) continue;
      try {
        await repository(record);
        related.push(record);
        ids.add(record.workspaceId);
        for (const id of await this.retainedSources(parentId, record, records)) ids.add(id);
      } catch {
        /* Missing tasks can still contribute captured evidence below. */
      }
    }
    const result: DevelopmentReviewScope[] = [];
    for (const id of ids) {
      const workspace = await this.workspaces.get(id);
      if (!workspace) {
        result.push({
          workspaceId: id,
          sourceWorkspaceId: id,
          label: id,
          path: "",
          branch: null,
          status: "unavailable",
          error: "Registered source removed",
        });
        continue;
      }
      const sourceId = related.some((item) => item.workspaceId === id)
        ? await this.liveSource(parentId, workspace)
        : id;
      result.push(await this.scope(parentId, workspace, sourceId, false));
    }
    for (const task of records) {
      if (!task.isPaseoOwnedWorktree || !(await this.descendant(parentId, task))) continue;
      for (const evidence of [
        ...(task.developmentEvidenceHistory ?? []),
        task.developmentEvidence,
      ]) {
        if (evidence)
          result.push(
            await this.scope(
              parentId,
              { ...task, developmentEvidence: evidence },
              evidence.sourceWorkspaceId,
            ),
          );
      }
    }
    return result;
  }
  private async selected(request: DevelopmentReviewReadRequest) {
    const parent = await this.get(request.workspaceId);
    if (!request.scopeWorkspaceId) throw new Error("Selected development scope unavailable");
    const workspace = await this.get(request.scopeWorkspaceId);
    const evidence = request.evidenceId
      ? [...(workspace.developmentEvidenceHistory ?? []), workspace.developmentEvidence].find(
          (entry) => entry?.id === request.evidenceId,
        )
      : undefined;
    if (request.evidenceId && !evidence)
      throw new Error("Selected development evidence unavailable");
    const sourceId = evidence
      ? evidence.sourceWorkspaceId
      : await this.liveSource(parent.workspaceId, workspace);
    if (
      evidence &&
      (!workspace.isPaseoOwnedWorktree || !(await this.descendant(parent.workspaceId, workspace)))
    )
      throw new Error("Selected development scope unavailable");
    const scope = await this.scope(
      parent.workspaceId,
      { ...workspace, developmentEvidence: evidence },
      sourceId,
      Boolean(evidence),
    );
    if (request.scopeToken !== scope.scopeToken)
      throw new Error("Selected development scope changed; select the source again");
    if (scope.status === "unavailable")
      throw new Error(scope.error ?? "Selected development scope unavailable");
    return { workspace, evidence, scope };
  }
  async read(request: DevelopmentReviewReadRequest) {
    if (request.operation === "list")
      return {
        scopes: await this.list(request.workspaceId),
      };
    const { workspace, evidence, scope } = await this.selected(request);
    const scopes = [scope];
    const file = relativeFile(request.path);
    if (evidence) {
      const source = await this.linked(request.workspaceId, evidence.sourceWorkspaceId);
      const cwd = source.cwd;
      if (request.operation === "diff") {
        const diff = await git(cwd, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          evidence.baseSha,
          evidence.headSha,
          "--",
        ]);
        return { scopes, diff, files: reviewFiles(diff) };
      }
      if (request.operation === "file")
        return {
          scopes,
          content: boundedText(await git(cwd, ["show", `${evidence.headSha}:${file}`])),
        };
      const prefix = file ? `${file.replace(/\/$/, "")}/` : "";
      const listing = await git(cwd, ["ls-tree", "-z", evidence.headSha, "--", prefix || "."]);
      const entries = listing
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const tab = entry.indexOf("\t");
          const header = entry.slice(0, tab);
          const name = entry.slice(tab + 1);
          return {
            name: path.basename(name),
            path: name,
            kind: header.includes(" tree ") ? ("directory" as const) : ("file" as const),
            size: 0,
            modifiedAt: "",
          };
        });
      return { scopes, entries };
    }
    if (request.operation === "files")
      return {
        scopes,
        entries: (await listDirectoryEntries({ root: workspace.cwd, relativePath: file })).entries,
      };
    if (request.operation === "file") {
      const result = await readExplorerFile({ root: workspace.cwd, relativePath: file });
      if (result.kind !== "text")
        throw new Error("Development review currently supports text files");
      return { scopes, content: boundedText(result.content ?? "") };
    }
    const diff = await liveDiff(workspace.cwd);
    return { scopes, diff, files: reviewFiles(diff) };
  }
}
