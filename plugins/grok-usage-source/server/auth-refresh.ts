import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The official CLI owns refresh-token rotation, its OS lock and atomic credential
// writes. Never implement a competing auth.json writer in this plugin.
const inFlight = new Map<string, Promise<string | undefined>>();
const retryAfter = new Map<string, number>();

export function refreshGrokToken(locator: string): Promise<string | undefined> {
  const path = resolve(locator);
  // Do not refresh a different account/home than the one discovery selected.
  if (path !== join(homedir(), ".grok", "auth.json")) return Promise.resolve(undefined);
  const pending = inFlight.get(path);
  if (pending) return pending;
  if ((retryAfter.get(path) ?? 0) > Date.now()) return Promise.resolve(undefined);
  const task = requestNativeToken().finally(() => {
    inFlight.delete(path);
    retryAfter.set(path, Date.now() + 30_000);
  });
  inFlight.set(path, task);
  return task;
}

export function requestNativeToken(): Promise<string | undefined> {
  return new Promise((resolveResult) => {
    // Never join an existing leader or create a session. No model prompts,
    // tools, automatic permission approvals, debug logs, or browser login.
    const env = { ...process.env };
    for (const key of ["GROK_HOME", "GROK_API_KEY", "GROK_TOKEN", "XAI_API_KEY", "RUST_LOG"]) {
      delete env[key];
    }
    const child = spawn("grok", ["agent", "--no-leader", "stdio"], {
      cwd: tmpdir(),
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let done = false;
    let buffer = "";
    let bytes = 0;
    let initialized = false;
    const timer = setTimeout(() => finish(), 10_000);
    function finish(token?: string) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      buffer = "";
      child.stdin.destroy();
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
      child.once("close", () => clearTimeout(killTimer));
      // The done guard makes all event/timeout paths resolve exactly once.
      // eslint-disable-next-line promise/no-multiple-resolved
      resolveResult(token);
    }
    function send(id: number, method: string, params: object) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    }
    child.on("error", () => finish());
    child.on("close", () => finish());
    child.stdin.on("error", () => finish());
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return finish();
      buffer += chunk.toString("utf8");
      let newline: number;
      while (!done && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          // Any server-initiated request is rejected; auth lookup needs none.
          if (message.method && message.id != null) return finish();
          if (message.id === 1 && !initialized) {
            if (message.error || !message.result) return finish();
            initialized = true;
            send(2, "_x.ai/auth/getBearerToken", {});
          } else if (message.id === 2 && initialized) {
            const token = message.result?.result?.token;
            finish(
              !message.error && typeof token === "string" && token.length > 0 ? token : undefined,
            );
          }
        } catch {
          finish();
        }
      }
    });
    send(1, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "paseo-usage", version: "1" },
    });
  });
}
