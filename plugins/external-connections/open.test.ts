import { expect, it, vi } from "vitest";
import type { PluginSessionOpenRequest, PluginSettingsState } from "@getpaseo/plugin/server";
import { openConnections } from "./server/open.js";
import { preferences } from "./shared/preferences.js";
const request: PluginSessionOpenRequest = {
  agentId: "lead-1",
  workspaceId: null,
  provider: "codex",
  cwd: "/project",
  reason: "create",
  purpose: "interactive",
  title: null,
  labels: {},
  metadata: {},
  tools: [],
  env: {},
  mcpServers: { existing: { type: "http", url: "http://localhost:1/mcp" } },
};
const connection = {
  id: "docs",
  name: "Docs",
  enabled: true,
  url: "https://example.com/mcp",
  providers: ["codex", "claude"],
};
function ready(enabled = true): PluginSettingsState<typeof preferences.schema> {
  return {
    status: "ready",
    revision: "1",
    values: preferences.schema.parse({ connections: [{ ...connection, enabled }] }),
  };
}
it("history opens never read external settings or attach tools", async () => {
  const read = vi.fn(async () => ready());
  expect(await openConnections({ read }, { ...request, purpose: "history" })).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});
it("invalid settings fail closed without modifying the request", async () => {
  const read = async (): Promise<PluginSettingsState<typeof preferences.schema>> => ({
    status: "invalid",
    revision: "1",
    error: "invalid document",
  });
  expect(await openConnections({ read }, request)).toBeUndefined();
});
it.each(["codex", "claude"])(
  "passes host MCP contributions through %s without replacing other tools",
  async (provider) => {
    const result = await openConnections({ read: async () => ready() }, { ...request, provider });
    expect(result?.mcpServers).toEqual({
      ...request.mcpServers,
      "external-docs": { type: "http", url: connection.url },
    });
    expect(request.mcpServers).not.toHaveProperty("external-docs");
    expect(result?.env).toEqual({});
    expect(result?.tools).toEqual([]);
  },
);
it("reads current configuration again on each resume and adds nothing after disable", async () => {
  const read = vi.fn().mockResolvedValueOnce(ready()).mockResolvedValueOnce(ready(false));
  expect((await openConnections({ read }, request))?.mcpServers).toHaveProperty("external-docs");
  expect((await openConnections({ read }, { ...request, reason: "resume" }))?.mcpServers).toEqual(
    request.mcpServers,
  );
});
it("does not expose external MCP to unsupported providers", async () => {
  expect(
    (await openConnections({ read: async () => ready() }, { ...request, provider: "cursor" }))
      ?.mcpServers,
  ).toEqual(request.mcpServers);
});
