import { expect, it } from "vitest";
import { connectedClientSnapshots } from "./connected-clients.js";
it("counts live sessions once across sockets and excludes disconnected/plugin sessions", () => {
  const app = {
    clientId: "phone",
    clientType: "mobile",
    appVersion: "1",
    connectedAt: "2026-11-11T00:00:00Z",
    lifecycle: "reconnectable",
    clientCapabilities: { deviceLabel: "Phone", privateToken: "never-return" },
    sockets: new Set([{}, {}]),
  };
  expect(
    connectedClientSnapshots([
      app,
      app,
      { ...app, clientId: "disconnected", sockets: new Set() },
      { ...app, clientId: "plugin", lifecycle: "ephemeral-plugin" },
    ]),
  ).toEqual([
    {
      clientId: "phone",
      clientType: "mobile",
      appVersion: "1",
      connectedAt: app.connectedAt,
      label: "Phone",
    },
  ]);
});
