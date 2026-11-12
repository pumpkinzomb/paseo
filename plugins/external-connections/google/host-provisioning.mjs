import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { provisionGoogleDevelopmentStore } from "./dev-helper.mjs";
import { resolveTrustedGoogleHelper } from "./helper-trust.mjs";
import { createGoogleKeychainStore } from "./keychain-store.mjs";
import { createProvisionedGoogleService } from "./provisioned-service.mjs";

/** Parameters are injected only by the daemon's builtin-plugin host context. */
export function createHostGoogleService({
  stateDirectory,
  runtimeMode,
  prepareDevelopmentStore = provisionGoogleDevelopmentStore,
  resolvePackagedHelper = resolveTrustedGoogleHelper,
  createStore = createGoogleKeychainStore,
  createProvisioned = createProvisionedGoogleService,
}) {
  if (!path.isAbsolute(stateDirectory) || !["development", "packaged"].includes(runtimeMode))
    throw new Error("INVALID_GOOGLE_HOST_CONTEXT");
  let prepared = null;
  let preparing = null;
  let stopped = false;

  async function configured() {
    try {
      const file = path.join(stateDirectory, "google-client.json");
      const info = await fs.lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 4096 ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0
      )
        return false;
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      return (
        typeof value.clientId === "string" &&
        /^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(value.clientId)
      );
    } catch {
      return false;
    }
  }
  async function ensure() {
    if (stopped) throw new Error("GOOGLE_SERVICE_STOPPED");
    if (prepared) return prepared;
    if (!preparing)
      preparing = (async () => {
        let store;
        if (runtimeMode === "development") {
          store = await prepareDevelopmentStore({
            directory: path.join(stateDirectory, "native-helper"),
          });
        } else {
          const helperPath = resolvePackagedHelper();
          store = createStore({
            helperPath,
            verifyHelper: () => {
              if (resolvePackagedHelper() !== helperPath)
                throw new Error("SECURE_STORE_UNAVAILABLE");
            },
          });
        }
        // Isolate live, lab, and other profiles even though they share the OS Keychain.
        // The host state path is stable across releases, never supplied through RPC.
        const namespace = createHash("sha256").update(stateDirectory).digest("hex");
        const scopedStore = {
          read: (account) => store.read(`${namespace}-${account}`),
          write: (account, value) => store.write(`${namespace}-${account}`, value),
          delete: (account) => store.delete(`${namespace}-${account}`),
        };
        const service = createProvisioned({ stateDirectory, store: scopedStore });
        if (stopped) {
          await service.dispose();
          throw new Error("GOOGLE_SERVICE_STOPPED");
        }
        prepared = service;
        return service;
      })().finally(() => {
        preparing = null;
      });
    return preparing;
  }
  return {
    async status() {
      if (stopped) throw new Error("GOOGLE_SERVICE_STOPPED");
      // No compiler/Keychain activity merely from opening settings before setup.
      if (!prepared && !(await configured()))
        return { status: "setup-required", scopes: [], reason: "oauth-client-missing" };
      let service;
      try {
        service = await ensure();
      } catch {
        return { status: "setup-required", scopes: [], reason: "secure-store-unavailable" };
      }
      return service.status();
    },
    async configure(input) {
      return (await ensure()).configure(input);
    },
    async begin(scopes) {
      return (await ensure()).begin(scopes);
    },
    async cancel() {
      return prepared ? prepared.cancel() : false;
    },
    async forget() {
      return (await ensure()).forget();
    },
    async openAgent(input) {
      if (!(await configured())) throw new Error("GOOGLE_SETUP_REQUIRED");
      return (await ensure()).openAgent(input);
    },
    closeAgent(agentId) {
      if (prepared) prepared.closeAgent(agentId);
    },
    async dispose() {
      stopped = true;
      if (preparing) await preparing.catch(() => {});
      if (prepared) await prepared.dispose();
    },
  };
}
