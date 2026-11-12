import type { Connection } from "./preferences.js";

export function connectionServers(
  connections: Connection[],
  provider: string,
  purpose: "interactive" | "history" = "interactive",
) {
  const servers: Record<string, { type: "http"; url: string }> = {};
  if (purpose !== "interactive") return servers;
  for (const connection of connections) {
    if (!connection.enabled || !connection.providers.some((value) => value === provider)) continue;
    servers[`external-${connection.id}`] = { type: "http", url: connection.url };
  }
  return servers;
}
