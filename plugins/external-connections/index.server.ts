import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences } from "./shared/preferences.js";
import { registerGoogleConnectionRpc } from "./server/google-controller.js";
import { openConnections } from "./server/open.js";

export default function contribute(server: PluginServerContext) {
  // A trusted host credential service must be supplied before Google login is enabled.
  registerGoogleConnectionRpc(server);
  const settings = server.registerSettings(preferences);
  return server.addHook("agent.open.before", ({ request }) => openConnections(settings, request));
}
