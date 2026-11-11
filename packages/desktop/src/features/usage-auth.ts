import { execFile } from "node:child_process";

type LoginRunner = () => Promise<void>;
const runCursorLogin: LoginRunner = () =>
  new Promise((resolve, reject) => {
    // No shell, user/plugin supplied arguments, credential copying, or output logging.
    execFile("cursor-agent", ["login"], { timeout: 180_000, maxBuffer: 256 * 1024 }, (error) => {
      if (error)
        reject(
          new Error("Cursor sign-in did not complete. Try again and finish the browser login."),
        );
      else resolve();
    });
  });

export function createUsageAuthenticator(run: LoginRunner = runCursorLogin) {
  let pending: Promise<void> | null = null;
  return (sourceId: unknown): Promise<void> => {
    if (sourceId !== "cursor")
      return Promise.reject(
        new Error("Sign in with this provider on its host, then refresh usage."),
      );
    if (pending) return pending;
    pending = run().finally(() => {
      pending = null;
    });
    return pending;
  };
}
