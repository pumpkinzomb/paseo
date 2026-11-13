import type { PluginSessionOpenRequest, PluginSettings } from "@getpaseo/plugin/server";
import { preferences } from "../shared/preferences.js";
import { connectionServers } from "../shared/servers.js";

export async function openConnections(
  settings: Pick<PluginSettings<typeof preferences.schema>, "read">,
  request: PluginSessionOpenRequest,
): Promise<PluginSessionOpenRequest | undefined> {
  if (request.purpose !== "interactive") return;
  const state = await settings.read();
  if (state.status !== "ready") return;
  return {
    ...request,
    mcpServers: {
      ...request.mcpServers,
      ...connectionServers(state.values.connections, request.provider, request.purpose),
    },
  };
}
