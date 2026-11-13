/** Narrow, inert-by-default bridge. Registration is intentionally not wired into main. */
export const LOCAL_UPDATE_CHANNELS = {
  status: "local-update:status",
  request: "local-update:request",
} as const;

export interface LocalUpdateDriverStatus {
  /** Native-verified daemon targeted by this update, never the selected remote host. */
  serverId?: string;
  currentVersion: string;
  candidate?: { version: string; token: string };
  phase?: "idle" | "applying" | "failed";
}
export interface LocalUpdateDriver {
  readStatus(): Promise<LocalUpdateDriverStatus>;
  /** Revalidate the pinned candidate in the controller before any filesystem action. */
  requestUpdate(token: string): Promise<void>;
}
export interface LocalUpdateIpcStatus {
  /** Native-verified daemon targeted by this update, never the selected remote host. */
  serverId?: string;
  currentVersion: string;
  phase: "idle" | "applying" | "failed";
  canApply: boolean;
  candidate?: { version: string; token: string };
}
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
export interface LocalUpdateIpcRegistrar {
  handle(channel: string, handler: Handler): void;
  removeHandler(channel: string): void;
}
const validToken = (token: unknown): token is string =>
  typeof token === "string" && /^[a-f0-9]{64}$/.test(token);

export function registerLocalUpdateIpc({
  ipcMain,
  isTrustedSender,
  productionReady = false,
  driver,
}: {
  ipcMain: LocalUpdateIpcRegistrar;
  /** Must validate the sender frame and app origin, not merely the window ID. */
  isTrustedSender(event: unknown): boolean;
  productionReady?: boolean;
  driver: LocalUpdateDriver;
}): () => void {
  let active: { token: string; promise: Promise<void> } | undefined;
  const consumed = new Set<string>();
  let disposed = false;
  function assertTrusted(event: unknown) {
    if (disposed || !isTrustedSender(event)) throw new Error("Untrusted local update sender");
  }
  const readStatus: Handler = async (event, ...args) => {
    assertTrusted(event);
    if (args.length !== 0) throw new Error("Invalid local update status request");
    const status = await driver.readStatus().catch(() => {
      throw new Error("Local update status unavailable");
    });
    const candidate = status.candidate;
    const canApply = Boolean(
      productionReady &&
      !active &&
      status.phase !== "applying" &&
      candidate &&
      validToken(candidate.token) &&
      !consumed.has(candidate.token),
    );
    const result: LocalUpdateIpcStatus = {
      currentVersion: status.currentVersion,
      phase: active ? "applying" : (status.phase ?? "idle"),
      canApply,
    };
    if (status.serverId?.trim()) result.serverId = status.serverId;
    if (canApply && candidate)
      result.candidate = { version: candidate.version, token: candidate.token };
    return result;
  };
  const request: Handler = async (event, ...args) => {
    assertTrusted(event);
    if (!productionReady) throw new Error("Local updates are not enabled");
    if (args.length !== 1 || !validToken(args[0])) throw new Error("Invalid local update token");
    const token = args[0];
    if (active) {
      if (active.token === token)
        return active.promise.catch(() => {
          throw new Error("Local update request failed");
        });
      throw new Error("Local update already in progress");
    }
    if (consumed.has(token)) throw new Error("Local update token already used");
    // Set the lock before awaiting any controller operation.
    const promise = Promise.resolve().then(async () => {
      const status = await driver.readStatus();
      if (disposed || status.phase === "applying" || status.candidate?.token !== token) {
        throw new Error("Local update candidate is no longer available");
      }
      consumed.add(token);
      return driver.requestUpdate(token);
    });
    active = { token, promise };
    try {
      await promise;
    } catch {
      throw new Error("Local update request failed");
    } finally {
      active = undefined;
    }
  };
  ipcMain.handle(LOCAL_UPDATE_CHANNELS.status, readStatus);
  try {
    ipcMain.handle(LOCAL_UPDATE_CHANNELS.request, request);
  } catch (error) {
    ipcMain.removeHandler(LOCAL_UPDATE_CHANNELS.status);
    throw error;
  }
  return () => {
    disposed = true;
    ipcMain.removeHandler(LOCAL_UPDATE_CHANNELS.status);
    ipcMain.removeHandler(LOCAL_UPDATE_CHANNELS.request);
  };
}
