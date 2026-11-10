import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import type { AgentClient } from "../agent-sdk-types.js";

const ConnectedSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  reused: z.boolean(),
});

test("local provider tools list without running, require handoff confirmation, and reuse native connections", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "paseo-provider-tools-")));
  let turns = 0;
  let imports = 0;
  const fake = createTestAgentClient("codex", {
    onStartTurn: () => {
      turns += 1;
    },
  });
  const provider: AgentClient = {
    provider: "codex",
    capabilities: { ...fake.capabilities, supportsSessionListing: true },
    createSession: fake.createSession.bind(fake),
    resumeSession: fake.resumeSession.bind(fake),
    fetchCatalog: fake.fetchCatalog.bind(fake),
    isAvailable: fake.isAvailable.bind(fake),
    listImportableSessions: async () => [
      {
        providerHandleId: "native-thread",
        cwd,
        title: "Existing local work",
        firstPromptPreview: "Original request",
        lastPromptPreview: "Original request",
        lastActivityAt: new Date("2026-11-10T12:00:00.000Z"),
      },
    ],
    importSession: async (input, context) => {
      imports += 1;
      const persistence = { provider: "codex", sessionId: input.providerHandleId };
      return {
        session: await fake.resumeSession(persistence, context.config, context.launchContext),
        config: context.storedConfig,
        persistence,
        timeline: [],
      };
    },
  };
  const daemon = await createTestPaseoDaemon({
    agentClients: { codex: provider },
    mcpEnabled: true,
  });
  const mcp = new Client({ name: "provider-sessions-test", version: "1" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`)),
    );
    await client.connect();
    const listed = await mcp.callTool({
      name: "list_provider_sessions",
      arguments: { providers: ["codex"] },
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      entries: [{ providerHandleId: "native-thread", cwd }],
      externalActivity: "unknown",
    });
    expect(imports).toBe(0);
    expect(turns).toBe(0);
    const args = { providerId: "codex", providerHandleId: "native-thread", cwd };
    const denied = await mcp.callTool({
      name: "connect_provider_session",
      arguments: { ...args, externalSessionIdleConfirmed: false },
    });
    expect(denied.isError).toBe(true);
    expect(imports).toBe(0);
    const connected = await mcp.callTool({
      name: "connect_provider_session",
      arguments: { ...args, externalSessionIdleConfirmed: true },
    });
    expect(connected.isError).not.toBe(true);
    const connection = ConnectedSchema.parse(connected.structuredContent);
    expect(connection.reused).toBe(false);
    const reused = await mcp.callTool({
      name: "connect_provider_session",
      arguments: { ...args, externalSessionIdleConfirmed: true },
    });
    expect(reused.structuredContent).toEqual({ ...connection, reused: true });
    expect(imports).toBe(1);
    expect(turns).toBe(0);
    const history = await client.fetchRecentProviderSessions({
      providers: ["codex"],
      includeImported: true,
    });
    expect(history.entries).toMatchObject([
      { providerHandleId: "native-thread", linkedAgentId: connection.agentId },
    ]);
    const unlinked = await client.fetchRecentProviderSessions({ providers: ["codex"] });
    expect(unlinked.entries).toEqual([]);
    const nativeIdentity = daemon.daemon.agentManager.getAgent(connection.agentId)?.persistence
      ?.sessionId;
    expect(nativeIdentity).toBe("native-thread");
  } finally {
    await mcp.close();
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
