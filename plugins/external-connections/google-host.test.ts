import { expect, it } from "vitest";
import { bridgeSessionSchema, deferredGoogleService } from "./server/google-host.js";
it("no trusted builtin context means no Google host service", () => {
  expect(deferredGoogleService(undefined)).toBeUndefined();
});
it("accepts only authenticated fixed-loopback bridge sessions", () => {
  const base = {
    url: "http://127.0.0.1:45678/mcp",
    headers: { Authorization: "Bearer ephemeral-test" },
    expiresAt: 12345,
  };
  expect(bridgeSessionSchema.safeParse(base).success).toBe(true);
  expect(bridgeSessionSchema.safeParse({ ...base, url: "https://other.example/mcp" }).success).toBe(
    false,
  );
  expect(bridgeSessionSchema.safeParse({ ...base, headers: {} }).success).toBe(false);
  expect(
    bridgeSessionSchema.safeParse({ ...base, url: "http://127.0.0.1:45678/mcp?token=secret" })
      .success,
  ).toBe(false);
  expect(
    bridgeSessionSchema.safeParse({ ...base, headers: { Authorization: "Bearer x\r\nOther: x" } })
      .success,
  ).toBe(false);
});
