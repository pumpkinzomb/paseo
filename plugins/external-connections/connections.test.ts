import { describe, expect, it } from "vitest";
import { preferences, connectionSchema, endpointSchema } from "./shared/preferences.js";
import { connectionServers } from "./shared/servers.js";
const connection = {
  id: "google",
  name: "Google bridge",
  url: "http://127.0.0.1:9900/mcp",
  enabled: true,
  providers: ["codex", "claude"],
};
describe("external connections", () => {
  it("defaults to no external access", () => {
    expect(preferences.schema.parse({}).connections).toEqual([]);
    expect(connectionSchema.parse({ ...connection, enabled: undefined }).enabled).toBe(false);
  });
  it.each([
    "not a url",
    "http://remote.example/mcp",
    "https://user:password@example.com/mcp",
    "https://example.com/mcp?token=secret",
    "https://example.com/mcp#secret",
    "file:///tmp/mcp",
  ])("rejects insecure or credential-bearing URL %s", (url) => {
    expect(endpointSchema.safeParse(url).success).toBe(false);
  });
  it.each(["https://example.com/mcp", "http://localhost:9000/mcp", "http://[::1]:9000/mcp"])(
    "allows endpoint %s",
    (url) => {
      expect(endpointSchema.safeParse(url).success).toBe(true);
    },
  );
  it("rejects duplicate IDs and hidden credentials", () => {
    expect(preferences.schema.safeParse({ connections: [connection, connection] }).success).toBe(
      false,
    );
    expect(
      connectionSchema.safeParse({ ...connection, headers: { Authorization: "secret" } }).success,
    ).toBe(false);
  });
  it("injects only enabled selected providers with a namespaced ID", () => {
    const parsed = connectionSchema.parse(connection);
    expect(connectionServers([parsed], "codex")).toEqual({
      "external-google": { type: "http", url: connection.url },
    });
    expect(connectionServers([parsed], "codex", "history")).toEqual({});
    expect(connectionServers([parsed], "cursor")).toEqual({});
    expect(connectionServers([{ ...parsed, enabled: false }], "claude")).toEqual({});
    expect(connectionServers([{ ...parsed, providers: ["claude"] }], "codex")).toEqual({});
  });
});
