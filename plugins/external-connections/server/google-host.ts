import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { GoogleConnectionService } from "./google-controller.js";
import { z } from "zod";

export interface GoogleHostService extends GoogleConnectionService {
  openAgent(input: { agentId: string; provider: string }): Promise<{
    url: string;
    headers: { Authorization: string };
    expiresAt: number;
  }>;
  closeAgent(agentId: string): void;
  dispose(): Promise<void>;
  getUpdateBlockers?(): readonly string[];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
const serviceSchema = z.custom<GoogleHostService>(
  (value) =>
    record(value) &&
    [
      "status",
      "configure",
      "begin",
      "cancel",
      "forget",
      "openAgent",
      "closeAgent",
      "dispose",
    ].every((key) => typeof value[key] === "function"),
);
export const bridgeSessionSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        Boolean(url.port) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
  headers: z.object({ Authorization: z.string().regex(/^Bearer [A-Za-z0-9_-]+$/) }).strict(),
  expiresAt: z.number().finite(),
});
/** Import the trusted module file directly so its native helper source URLs survive bundling. */
export async function loadGoogleHostService(
  host: NonNullable<PluginServerContext["builtinHost"]>,
): Promise<GoogleHostService> {
  const root = await realpath(host.pluginDirectory);
  const entry = path.join(root, "google", "host-provisioning.mjs");
  if ((await realpath(entry)) !== entry) throw new Error("GOOGLE_HOST_MODULE_UNAVAILABLE");
  const module: unknown = await import(pathToFileURL(entry).href);
  if (!record(module) || typeof module.createHostGoogleService !== "function")
    throw new Error("GOOGLE_HOST_MODULE_UNAVAILABLE");
  const service: unknown = await module.createHostGoogleService({
    stateDirectory: host.stateDirectory,
    runtimeMode: host.runtimeMode,
  });
  return serviceSchema.parse(service);
}
export function deferredGoogleService(host: PluginServerContext["builtinHost"]) {
  if (!host) return undefined;
  // Loading a factory must not compile helpers, inspect Keychain or start OAuth.
  // The host implementation prepares secure storage only on explicit configure.
  const service = loadGoogleHostService(host);
  let loaded: GoogleHostService | undefined;
  let loadState: "loading" | "ready" | "failed" = "loading";
  let active = 0;
  void service
    .then((ready) => {
      loaded = ready;
      loadState = "ready";
      return undefined;
    })
    .catch(() => {
      loadState = "failed";
    });
  const tracked = async <T>(action: () => Promise<T>): Promise<T> => {
    active++;
    try {
      return await action();
    } finally {
      active--;
    }
  };
  const delegate: GoogleHostService = {
    status: () =>
      tracked(async () => {
        try {
          return await (await service).status();
        } catch {
          return {
            status: "setup-required",
            scopes: [],
            reason: "secure-store-unavailable",
          };
        }
      }),
    configure: (input) =>
      tracked(async () => {
        const ready = await service;
        if (!ready.configure) throw new Error("GOOGLE_SETUP_REQUIRED");
        return ready.configure(input);
      }),
    begin: (scopes) => tracked(async () => (await service).begin(scopes)),
    cancel: () => tracked(async () => (await service).cancel()),
    forget: () => tracked(async () => (await service).forget()),
    openAgent: (input) =>
      tracked(async () => bridgeSessionSchema.parse(await (await service).openAgent(input))),
    closeAgent: (agentId) => {
      void tracked(async () => (await service).closeAgent(agentId)).catch(() => {});
    },
    dispose: () =>
      tracked(async () => {
        try {
          await (await service).dispose();
        } catch {
          /* unavailable service owns no bridge */
        }
      }),
    getUpdateBlockers: () => {
      const blockers = active ? [`google delegate: ${active} active`] : [];
      if (loadState !== "ready" || !loaded?.getUpdateBlockers)
        return [...blockers, "google service snapshot unknown"];
      try {
        const downstream = loaded.getUpdateBlockers();
        if (!Array.isArray(downstream) || downstream.some((item) => typeof item !== "string"))
          return [...blockers, "google service snapshot unknown"];
        return [...blockers, ...downstream];
      } catch {
        return [...blockers, "google service snapshot unknown"];
      }
    },
  };
  return delegate;
}
