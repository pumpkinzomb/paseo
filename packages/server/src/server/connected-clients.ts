import type { ConnectedClient } from "@getpaseo/protocol/messages";
interface Connection {
  clientId: string;
  clientType: string;
  appVersion: string | null;
  connectedAt: string;
  lifecycle: string;
  clientCapabilities: Record<string, unknown> | null;
  sockets: ReadonlySet<unknown>;
}
export function connectedClientSnapshots(
  connections: Iterable<Connection>,
): Omit<ConnectedClient, "isCurrentClient">[] {
  return [...new Set(connections)]
    .filter(
      (connection) => connection.sockets.size > 0 && connection.lifecycle !== "ephemeral-plugin",
    )
    .map((connection) => ({
      clientId: connection.clientId,
      clientType: connection.clientType,
      connectedAt: connection.connectedAt,
      appVersion: connection.appVersion,
      label:
        typeof connection.clientCapabilities?.deviceLabel === "string"
          ? connection.clientCapabilities.deviceLabel.slice(0, 100)
          : null,
    }));
}
