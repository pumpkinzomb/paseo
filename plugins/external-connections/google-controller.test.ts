import { expect, it, vi } from "vitest";
import { googleConnectionController, type GoogleConnectionService } from "./server/google-controller.js";
import { googleBeginRpc, type GoogleConnectionStatus } from "./shared/google-rpc.js";
const docs = "https://www.googleapis.com/auth/documents.readonly";
function service(overrides: Partial<GoogleConnectionService> = {}): GoogleConnectionService {
  return {
    status: async () => ({ status: "not-connected", scopes: [] }),
    begin: async () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test" }),
    cancel: async () => false,
    forget: async () => {},
    ...overrides,
  };
}
it("missing secure host service fails closed", async () => {
  const controller = googleConnectionController();
  expect(await controller.status()).toEqual({ status: "setup-required", scopes: [], reason: "secure-store-unavailable" });
  await expect(controller.begin({ scopes: [docs] })).rejects.toThrow("GOOGLE_SETUP_REQUIRED");
  expect(await controller.forget()).toEqual({ forgotten: false });
});
it("public status drops any unexpected host secrets", async () => {
  const result = { status: "credentials-stored", scopes: [docs], accessToken: "never expose" } satisfies GoogleConnectionStatus & { accessToken: string };
  expect(await googleConnectionController(service({ status: async () => result })).status()).toEqual({ status: "credentials-stored", scopes: [docs] });
});
it("does not claim cancellation during token exchange", async () => {
  expect(await googleConnectionController(service()).cancel()).toEqual({ cancelled: false });
});
it("starts only after explicit call and only once when busy", async () => {
  const begin = vi.fn(async () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" }));
  const controller = googleConnectionController(service({ begin, status: async () => ({ status: "authorizing", scopes: [] }) }));
  await controller.status(); expect(begin).not.toHaveBeenCalled();
  await expect(controller.begin({ scopes: [docs] })).rejects.toThrow("GOOGLE_AUTH_START_FAILED");
  expect(begin).not.toHaveBeenCalled();
});
it("sanitizes adapter errors instead of returning token payloads", async () => {
  const controller = googleConnectionController(service({ begin: async () => { throw new Error("token=secret"); } }));
  await expect(controller.begin({ scopes: [docs] })).rejects.toThrow(/^GOOGLE_AUTH_START_FAILED$/);
});
it.each(["https://evil.example/auth", "http://accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com.evil.example/o/oauth2/v2/auth"])("rejects unexpected OAuth destination %s", async (authorizationUrl) => {
  await expect(googleConnectionController(service({ begin: async () => ({ authorizationUrl }) })).begin({ scopes: [docs] })).rejects.toThrow("GOOGLE_AUTH_START_FAILED");
});
it("allows explicit Docs/Sheets write scopes but no Gmail send", () => {
  expect(googleBeginRpc.input.safeParse({ scopes: ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/spreadsheets"] }).success).toBe(true);
  expect(googleBeginRpc.input.safeParse({ scopes: ["https://www.googleapis.com/auth/gmail.send"] }).success).toBe(false);
});

it("configuration is explicit, returns only configured flag and sanitizes failures", async () => {
  const configure = vi.fn(async () => ({ configured: true as const }));
  const controller = googleConnectionController(service({ configure }));
  await controller.status(); expect(configure).not.toHaveBeenCalled();
  expect(await controller.configure({ clientId: "desktop.apps.googleusercontent.com", clientSecret: "transient-test" })).toEqual({ configured: true });
  await expect(googleConnectionController(service({ configure: async () => { throw new Error("secret-test"); } })).configure({ clientId: "desktop.apps.googleusercontent.com" })).rejects.toThrow(/^GOOGLE_SETUP_FAILED$/);
});
