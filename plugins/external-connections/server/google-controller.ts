import type { PluginServerContext } from "@getpaseo/plugin/server";
import { googleStatusRpc, googleBeginRpc, googleCancelRpc, googleForgetRpc, googleStatusSchema, type GoogleConnectionStatus, type GoogleScope } from "../shared/google-rpc.js";

/** Host-owned implementation only. Never expose access/refresh tokens across this boundary. */
export interface GoogleConnectionService {
  status(): Promise<GoogleConnectionStatus>;
  begin(scopes: GoogleScope[]): Promise<{ authorizationUrl: string }>;
  cancel(): Promise<boolean>;
  forget(): Promise<void>;
}
export function googleConnectionController(service?: GoogleConnectionService) {
  return {
    async status(): Promise<GoogleConnectionStatus> {
      if (!service) return { status: "setup-required", scopes: [], reason: "secure-store-unavailable" };
      try {
        // Project only public fields. A host adapter must never return tokens to clients.
        const state = await service.status();
        return googleStatusSchema.parse({ status: state.status, scopes: state.scopes, reason: state.reason });
      } catch { throw new Error("GOOGLE_STATUS_UNAVAILABLE"); }
    },
    async begin(input: { scopes: GoogleScope[] }) {
      if (!service) throw new Error("GOOGLE_SETUP_REQUIRED");
      try {
        const state = await service.status();
        if (state.status !== "not-connected" && state.status !== "credentials-stored") throw new Error("unavailable");
        const result = await service.begin([...new Set(input.scopes)]);
        return googleBeginRpc.output.parse({ authorizationUrl: result.authorizationUrl });
      } catch { throw new Error("GOOGLE_AUTH_START_FAILED"); }
    },
    async cancel() {
      if (!service) return { cancelled: false };
      try { return { cancelled: await service.cancel() }; }
      catch { throw new Error("GOOGLE_AUTH_CANCEL_FAILED"); }
    },
    async forget() {
      if (!service) return { forgotten: false };
      try { await service.forget(); return { forgotten: true }; }
      catch { throw new Error("GOOGLE_DISCONNECT_FAILED"); }
    },
  };
}
export function registerGoogleConnectionRpc(server: PluginServerContext, service?: GoogleConnectionService) {
  const controller = googleConnectionController(service);
  server.handle(googleStatusRpc, controller.status);
  server.handle(googleBeginRpc, controller.begin);
  server.handle(googleCancelRpc, controller.cancel);
  server.handle(googleForgetRpc, controller.forget);
}
