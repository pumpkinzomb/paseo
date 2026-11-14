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
  private async linked(parentId: string, sourceId: string): Promise<PersistedWorkspaceRecord> {
    const parent = await this.get(parentId);
    if (!parent.developmentSourceIds?.includes(sourceId))
      throw new Error("Source is not linked to this conversation");
    const source = await this.get(sourceId);
    if (parent.developmentSourceIdentities?.[sourceId] !== (await repository(source)))
      throw new Error("Linked repository identity changed; review and link the source again");
    return source;
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
    const scopeToken = createHash("sha256")
      .update(
        JSON.stringify([
          sourceId,
          parent.developmentSourceIdentities?.[sourceId],
          workspace.workspaceId,
          workspace.cwd,
          evidence?.id,
        ]),
      )
      .digest("hex");
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
  async list(parentId: string): Promise<DevelopmentReviewScope[]> {
    const parent = await this.get(parentId);
    const result: DevelopmentReviewScope[] = [];
    for (const sourceId of parent.developmentSourceIds ?? []) {
      const source = await this.workspaces.get(sourceId);
      if (source) result.push(await this.scope(parentId, source, sourceId));
      else
        result.push({
          workspaceId: sourceId,
          sourceWorkspaceId: sourceId,
          label: sourceId,
          path: "",
          branch: null,
          status: "unavailable",
          error: "Registered source removed",
        });
    }
    for (const task of await this.workspaces.listAll()) {
      if (!task.isPaseoOwnedWorktree || !(await this.descendant(parentId, task))) continue;
      for (const evidence of [
        ...(task.developmentEvidenceHistory ?? []),
        task.developmentEvidence,
      ]) {
        if (evidence && parent.developmentSourceIds?.includes(evidence.sourceWorkspaceId)) {
          result.push(
            await this.scope(
              parentId,
              { ...task, developmentEvidence: evidence },
              evidence.sourceWorkspaceId,
            ),
          );
        }
      }
      for (const sourceId of parent.developmentSourceIds ?? []) {
        try {
          if ((await repository(task)) === (await repository(await this.get(sourceId)))) {
            result.push(await this.scope(parentId, task, sourceId, false));
            break;
          }
        } catch {
          /* Removed tasks retain only their captured evidence. */
        }
      }
    }
    return result;
  }
  private async candidates(parentId: string) {
    const candidates = [];
    for (const workspace of await this.workspaces.listActive()) {
      if (workspace.workspaceId === parentId || workspace.untrustedSource) continue;
      try {
        await repository(workspace);
        candidates.push({
          workspaceId: workspace.workspaceId,
          label: workspace.title ?? workspace.displayName,
          path: workspace.cwd,
        });
      } catch {
        /* A removed/non-repository workspace is not an eligible source. */
      }
    }
    return candidates;
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
    let sourceId: string | undefined;
    if (parent.developmentSourceIds?.includes(workspace.workspaceId) && !evidence)
      sourceId = workspace.workspaceId;
    else {
      if (
        !workspace.isPaseoOwnedWorktree ||
        !(await this.descendant(parent.workspaceId, workspace))
      )
        throw new Error("Selected development scope unavailable");
      if (evidence) sourceId = evidence.sourceWorkspaceId;
      else {
        const identity = await repository(workspace);
        for (const id of parent.developmentSourceIds ?? []) {
          if (identity === (await repository(await this.get(id)))) {
            sourceId = id;
            break;
          }
        }
      }
    }
    if (!sourceId) throw new Error("Selected development scope unavailable");
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
        candidates: await this.candidates(request.workspaceId),
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
