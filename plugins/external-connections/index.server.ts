import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences } from "./shared/preferences.js";
import { connectionServers } from "./shared/servers.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  return server.addHook("agent.open.before", async ({ request }) => {
    // Reading history must not contact external services.
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
  });
}
