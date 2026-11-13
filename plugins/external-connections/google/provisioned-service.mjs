import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createGoogleConnectionService } from "./host-service.mjs";

/** stateDirectory and store are injected by the trusted builtin host, never RPC. */
export function createProvisionedGoogleService({
  stateDirectory,
  store,
  createService = createGoogleConnectionService,
}) {
  if (!path.isAbsolute(stateDirectory)) throw new Error("INVALID_HOST_STATE_DIRECTORY");
  const configPath = path.join(stateDirectory, "google-client.json");
  let service = null;
  let disposed = false;
  let queue = Promise.resolve();
  function serialize(action) {
    const next = queue
      .catch(() => {})
      .then(() => {
        if (disposed) throw new Error("GOOGLE_SERVICE_STOPPED");
        return action();
      });
    queue = next;
    return next;
  }
  async function directory() {
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(stateDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      (await fs.realpath(stateDirectory)) !== stateDirectory
    )
      throw new Error("INVALID_HOST_STATE_DIRECTORY");
  }
  function validClient(value) {
    return (
      typeof value === "string" && /^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(value)
    );
  }
  async function config() {
    await directory();
    try {
      const stat = await fs.lstat(configPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096 ||
        stat.uid !== process.getuid() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error("INVALID_CLIENT_CONFIGURATION");
      const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
      if (!validClient(parsed.clientId)) throw new Error("INVALID_CLIENT_CONFIGURATION");
      return parsed.clientId;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      // Sanitized boundary: filesystem error causes may contain credential storage paths.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("INVALID_CLIENT_CONFIGURATION");
    }
  }
  async function current() {
    if (service) return service;
    const clientId = await config();
    service = createService({
      clientId,
      store,
      getClientSecret: async () => {
        const raw = await store.read("paseo-google-client");
        if (raw === null) return null;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error("INVALID_CLIENT_CONFIGURATION");
        }
        if (
          parsed.clientId !== clientId ||
          (parsed.clientSecret !== null && typeof parsed.clientSecret !== "string")
        )
          throw new Error("INVALID_CLIENT_CONFIGURATION");
        return parsed.clientSecret;
      },
    });
    return service;
  }
  return {
    configure({ clientId, clientSecret }) {
      return serialize(async () => {
        if (!store) throw new Error("SECURE_STORE_UNAVAILABLE");
        if (
          !validClient(clientId) ||
          (clientSecret !== undefined &&
            (typeof clientSecret !== "string" ||
              !clientSecret ||
              clientSecret.length > 4096 ||
              /[\r\n]/.test(clientSecret)))
        )
          throw new Error("INVALID_CLIENT_CONFIGURATION");
        await directory();
        const previous = await current();
        const state = await previous.status();
        if (state.status === "authorizing" || state.status === "exchanging")
          throw new Error("GOOGLE_AUTH_IN_PROGRESS");
        if (state.status !== "setup-required") await previous.forget();
        await previous.dispose();
        service = null;
        // Write only to OS credential store; never put the secret in preferences/files.
        await store.write(
          "paseo-google-client",
          JSON.stringify({ clientId, clientSecret: clientSecret ?? null }),
        );
        const temporary = path.join(stateDirectory, `.client-${randomUUID()}`);
        try {
          await fs.writeFile(temporary, JSON.stringify({ clientId }), { mode: 0o600, flag: "wx" });
          await fs.rename(temporary, configPath);
        } finally {
          await fs.rm(temporary, { force: true });
        }
        await current();
        return { configured: true };
      });
    },
    status: () => serialize(async () => (await current()).status()),
    begin: (scopes) => serialize(async () => (await current()).begin(scopes)),
    cancel: () => serialize(async () => (await current()).cancel()),
    forget: () => serialize(async () => (await current()).forget()),
    openAgent: (input) => serialize(async () => (await current()).openAgent(input)),
    closeAgent: (agentId) => {
      if (service) service.closeAgent(agentId);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue.catch(() => {});
      if (service) await service.dispose();
    },
  };
}
