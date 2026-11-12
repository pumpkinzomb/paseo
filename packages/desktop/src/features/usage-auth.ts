import { execFile } from "node:child_process";

export const loginCommands = {
  cursor: { command: "cursor-agent", args: ["login"], label: "Cursor" },
  codex: { command: "codex", args: ["login"], label: "Codex" },
  claude: { command: "claude", args: ["auth", "login", "--claudeai"], label: "Claude" },
  grok: { command: "grok", args: ["login", "--oauth"], label: "Grok" },
} as const;
type LoginSource = keyof typeof loginCommands;
type LoginRunner = (source: LoginSource) => Promise<void>;
const runProviderLogin: LoginRunner = (source) =>
  new Promise((resolve, reject) => {
    // This bridge is only used for the local desktop host. A shell used to launch
    // Paseo may carry headless flags; they must not suppress this explicit login UI.
    const env = { ...process.env };
    for (const key of ["NO_OPEN_BROWSER", "SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"])
      delete env[key];
    // No shell, user/plugin supplied arguments, credential copying, or output logging.
    execFile(
      loginCommands[source].command,
      [...loginCommands[source].args],
      { env, timeout: 180_000, maxBuffer: 256 * 1024 },
      (error) => {
        if (error)
          reject(
            new Error(
              `${loginCommands[source].label} sign-in did not complete. Check that its CLI is installed, then retry and finish the browser login.`,
            ),
          );
        else resolve();
      },
    );
  });

export function createUsageAuthenticator(run: LoginRunner = runProviderLogin) {
  const pending = new Map<LoginSource, Promise<void>>();
  return (sourceId: unknown): Promise<void> => {
    if (typeof sourceId !== "string" || !Object.hasOwn(loginCommands, sourceId))
      return Promise.reject(
        new Error("Sign in with this provider on its host, then refresh usage."),
      );
    const source = sourceId as LoginSource;
    const existing = pending.get(source);
    if (existing) return existing;
    const task = run(source).finally(() => {
      pending.delete(source);
    });
    pending.set(source, task);
    return task;
  };
}
