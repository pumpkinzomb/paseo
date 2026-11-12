import { test, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";

// Actual daemon/worktree operations with fake providers: no model/network billing.
test("canonical and legacy editing children isolate from the selected project while reviews share it", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-development-delegation-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  await writeFile(join(root, "README.md"), "initial");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "initial");
  await writeFile(join(root, "unfinished.txt"), "parent-only");
  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const mcp = new Client({ name: "development-delegation-test", version: "1" });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent;
  };
  try {
    await client.connect();
    const manager = (await client.ensureDefaultAssistant()).agent;
    if (!manager) throw new Error("Expected manager");
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${manager.id}`),
      ),
    );
    const workspace = z
      .object({ workspaceId: z.string() })
      .parse(await call("create_workspace", { isolation: "local", path: root }));
    const base = {
      title: "Isolated edit",
      provider: "codex/gpt-5.4",
      settings: { modeId: "auto" },
      initialPrompt: "Inspect the assigned directory",
      notifyOnFinish: false,
    };
    const created = z.object({ cwd: z.string(), workspaceId: z.string(), guidance: z.string() });
    const invalid = await mcp.callTool({
      name: "create_agent",
      arguments: {
        ...base,
        workspaceId: workspace.workspaceId,
        settings: { modeId: "not-a-real-mode" },
      },
    });
    expect(invalid.isError).toBe(true);
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
    const children = await Promise.all([
      call("create_agent", { ...base, workspaceId: workspace.workspaceId }),
      call("create_agent", {
        ...base,
        relationship: { kind: "subagent" },
        workspace: { kind: "existing", workspaceId: workspace.workspaceId },
      }),
    ]);
    const [first, second] = children.map((child) => created.parse(child));
    expect(first.cwd).not.toBe(root);
    expect(second.cwd).not.toBe(first.cwd);
    expect(first.workspaceId).not.toBe(workspace.workspaceId);
    expect(git(first.cwd, "branch", "--show-current")).not.toBe(
      git(second.cwd, "branch", "--show-current"),
    );
    expect(git(first.cwd, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "HEAD"));
    await expect(access(join(first.cwd, "unfinished.txt"))).rejects.toThrow();
    expect(await readFile(join(root, "unfinished.txt"), "utf8")).toBe("parent-only");
    const metadataPath = git(first.cwd, "rev-parse", "--git-path", "paseo/worktree.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(metadata.baseRefName).toBe("main");
    expect(first.guidance).toContain("Review the child's diff");
    const review = created.parse(
      await call("create_agent", {
        ...base,
        workspaceId: workspace.workspaceId,
        taskKind: "read-only",
      }),
    );
    expect(review.cwd).toBe(root);
    expect(review.workspaceId).toBe(workspace.workspaceId);
    git(root, "checkout", "--detach");
    const failed = await mcp.callTool({
      name: "create_agent",
      arguments: { ...base, workspaceId: workspace.workspaceId },
    });
    expect(failed.isError).toBe(true);
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(3);
  } finally {
    await mcp.close();
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
