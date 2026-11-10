import { test, expect } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";

// Verifies orchestration plumbing, not an LLM's ability to autonomously plan or delegate.
test("a manager can create two parallel fake subagents and collect their results through MCP", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: () => {
        started += 1;
      },
      beforeTurnComplete: async () => {
        await barrier;
      },
    }),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const mcp = new Client({ name: "parallel-delegation-test", version: "1" });
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
    expect(started).toBe(0);
    const children = await Promise.all(
      ["codex/gpt-5.4", "claude/sonnet"].map(async (provider, index) => {
        const created = await call("create_agent", {
          relationship: { kind: "subagent" },
          workspace: { kind: "current" },
          title: `Parallel child ${index}`,
          provider,
          settings: { modeId: "auto" },
          initialPrompt: `Respond with exactly: CHILD_${index}_DONE`,
          notifyOnFinish: false,
        });
        return z.object({ agentId: z.string() }).parse(created).agentId;
      }),
    );
    await expect.poll(() => started).toBe(2);
    const statuses = await Promise.all(
      children.map(async (agentId) =>
        z
          .object({
            status: z.string(),
            snapshot: z.object({ labels: z.record(z.string(), z.string()) }),
          })
          .parse(await call("get_agent_status", { agentId })),
      ),
    );
    expect(statuses.map((status) => status.status)).toEqual(["running", "running"]);
    expect(
      statuses.every((status) => status.snapshot.labels[PARENT_AGENT_ID_LABEL] === manager.id),
    ).toBe(true);
    release();
    for (const [index, agentId] of children.entries()) {
      await expect
        .poll(
          async () =>
            z.object({ status: z.string() }).parse(await call("get_agent_status", { agentId }))
              .status,
        )
        .toBe("idle");
      const activity = z
        .object({ content: z.string() })
        .parse(await call("get_agent_activity", { agentId, limit: 20 }));
      expect(activity.content).toContain(`CHILD_${index}_DONE`);
    }
    const sent = await call("send_agent_prompt", {
      agentId: children[0],
      prompt: "Respond with exactly: FOLLOWUP_DONE",
      notifyOnFinish: false,
    });
    expect(z.object({ success: z.boolean() }).parse(sent).success).toBe(true);
    await expect.poll(() => started, { timeout: 10000 }).toBe(3);
    await expect
      .poll(
        async () =>
          z
            .object({ content: z.string() })
            .parse(await call("get_agent_activity", { agentId: children[0], limit: 20 })).content,
        { timeout: 10000 },
      )
      .toContain("FOLLOWUP_DONE");
  } finally {
    release();
    await mcp.close();
    await client.close();
    await daemon.close();
  }
}, 30000);
