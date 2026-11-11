import type { OpenUpdateRequest } from "./open-window.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface UpdateRequest {
  schemaVersion: 1;
  generation: string;
  requestId: string;
}

function parseRequest(value: unknown, generation: string): UpdateRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  if (
    request.schemaVersion !== 1 ||
    request.generation !== generation ||
    typeof request.requestId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(request.requestId)
  )
    return null;
  return { schemaVersion: 1, generation, requestId: request.requestId };
}

function validOpenRequest(raw: OpenUpdateRequest, generation: string): boolean {
  return (
    raw.generation === generation &&
    typeof raw.requestId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(raw.requestId) &&
    typeof raw.releaseDigest === "string" &&
    /^[a-f0-9]{64}$/.test(raw.releaseDigest) &&
    ["prepare", "commit", "abort"].includes(raw.phase) &&
    ["renderer", "full"].includes(raw.mode)
  );
}

// Synchronous persistence: no window-open event can interleave between the
// final safety check, durable acknowledgement, and quit commitment.
function writeResult(directory: string, filename: string, result: unknown): void {
  const temporary = path.join(directory, `.result-${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(result)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, path.join(directory, filename));
    const directoryFd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Opt-in supervisor protocol, never enabled in packaged builds. No renderer
 * checkpoint is assumed: every window and webContents must already be closed. */
export function createDevUpdateHandoff(deps: {
  isPackaged: boolean;
  directory?: string;
  generation?: string;
  windowCount: () => number;
  webContentsCount: () => number;
  quit: () => void;
  onError: (error: unknown) => void;
  openUpdate?: {
    handle(request: OpenUpdateRequest): Promise<Record<string, unknown>>;
    abort(reason: string): void;
  };
}) {
  const { directory, generation } = deps;
  const enabled =
    !deps.isPackaged && Boolean(directory && path.isAbsolute(directory) && generation);
  let pendingWindows = 0;
  let committed = false;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastResult = "";
  let processing = false;

  function validateDirectory(): boolean {
    if (!enabled || !directory) return false;
    const stat = fs.lstatSync(directory);
    return (
      stat.isDirectory() &&
      fs.realpathSync(directory) === path.resolve(directory) &&
      (stat.mode & 0o077) === 0 &&
      (!process.getuid || stat.uid === process.getuid())
    );
  }

  function dispose(): void {
    disposed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function reportError(error: unknown): void {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") deps.onError(error);
  }

  const unavailable = () => !enabled || disposed || committed;
  function poll(): void {
    if (unavailable() || !directory || !generation) return;
    try {
      // Only a private, same-user directory provided by the supervisor is valid.
      if (!validateDirectory()) return;
      const requestPath = path.join(directory, "request.json");
      const requestStat = fs.lstatSync(requestPath);
      if (!requestStat.isFile() || requestStat.size > 4096) return;
      const raw = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      if (raw?.schemaVersion === 2 && deps.openUpdate) {
        if (processing || !validOpenRequest(raw, generation)) return;
        processing = true;
        void deps.openUpdate
          .handle(raw)
          .then((result) => {
            if (disposed || !validateDirectory()) return null;
            // Controller must still request the identical phase after async checkpoints.
            if (
              JSON.stringify(JSON.parse(fs.readFileSync(requestPath, "utf8"))) !==
              JSON.stringify(raw)
            ) {
              deps.openUpdate?.abort("request-changed");
              return null;
            }
            writeResult(directory, "result.json", { ...raw, ...result });
            if (raw.phase === "commit" && result.state === "ready") {
              committed = true;
              deps.quit();
              // Normal beforeunload may veto quit. Never force kill or hold admission forever.
              setTimeout(() => {
                if (deps.windowCount() > 0) {
                  committed = false;
                  disposed = false;
                  if (!timer) {
                    timer = setInterval(poll, 1000);
                    timer.unref();
                  }
                  deps.openUpdate?.abort("quit-vetoed");
                  writeResult(directory, "result.json", {
                    ...raw,
                    state: "blocked",
                    blockers: ["quit-vetoed"],
                  });
                }
              }, 5000).unref();
            }
            return null;
          })
          .catch((error) => {
            deps.openUpdate?.abort("native-checkpoint-error");
            reportError(error);
          })
          .finally(() => {
            processing = false;
          });
        return;
      }
      const request = parseRequest(raw, generation);
      if (!request) return;
      const blocked = pendingWindows > 0 || deps.windowCount() > 0 || deps.webContentsCount() > 0;
      const result = {
        ...request,
        state: blocked ? "waiting-for-windows" : "ready",
        reason: blocked
          ? "Close all app windows and browser guests to apply the UI update safely."
          : "All windows and renderer contents are closed; daemon retained.",
      };
      const key = JSON.stringify(result);
      if (key !== lastResult) {
        writeResult(directory, "result.json", result);
        lastResult = key;
      }
      if (blocked) return;
      committed = true;
      dispose();
      deps.quit();
    } catch (error) {
      reportError(error);
    }
  }

  return {
    poll,
    dispose,
    markStarted(): void {
      if (disposed || !directory || !generation) return;
      try {
        if (validateDirectory())
          writeResult(directory, "started.json", {
            schemaVersion: 1,
            generation,
            state: "ready",
            features: { automaticOpenWindow: Boolean(deps.openUpdate) },
          });
      } catch (error) {
        reportError(error);
      }
    },
    start(): void {
      if (!enabled || disposed || timer) return;
      timer = setInterval(poll, 1000);
      timer.unref();
    },
    isCommitted: () => committed,
    beginWindowCreation(): () => void {
      if (committed) throw new Error("Desktop UI update is committed; window creation is blocked.");
      deps.openUpdate?.abort("window-created");
      pendingWindows += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pendingWindows -= 1;
      };
    },
  };
}
