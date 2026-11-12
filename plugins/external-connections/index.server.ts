import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences } from "./shared/preferences.js";
import { registerGoogleConnectionRpc } from "./server/google-controller.js";
import { deferredGoogleService } from "./server/google-host.js";
import { openConnections } from "./server/open.js";

export default function contribute(server: PluginServerContext) {
  const google = deferredGoogleService(server.builtinHost);
  registerGoogleConnectionRpc(server, google);
  const settings = server.registerSettings(preferences);
  const removeOpen = server.addHook("agent.open.before", async ({ request }) => {
    const next = (await openConnections(settings, request)) ?? request;
    if (
      !google ||
      request.purpose !== "interactive" ||
      !["codex", "claude"].includes(request.provider)
    )
      return next;
    try {
      if ((await google.status()).status !== "credentials-stored") return next;
      const session = await google.openAgent({
        agentId: request.agentId,
        provider: request.provider,
      });
      return {
        ...next,
        mcpServers: {
          ...next.mcpServers,
          "paseo-google": { type: "http", url: session.url, headers: session.headers },
        },
      };
    } catch {
      return next;
    }
  });
  const removeClose = server.addHook("agent.close.after", async ({ agent }) => {
    google?.closeAgent(agent.id);
  });
  return () => {
    removeOpen();
    removeClose();
    void google?.dispose();
  };
}
