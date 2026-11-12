import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences } from "./shared/preferences.js";
import { openConnections } from "./server/open.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  return server.addHook("agent.open.before", ({ request }) => openConnections(settings, request));
}
