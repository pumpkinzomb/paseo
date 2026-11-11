import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const CURSOR_CLI_KEYCHAIN_SERVICE = "cursor-access-token";

// Cursor CLI stores this per-user item on macOS, independently of the desktop DB.
export async function readCursorCliKeychainToken(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-a", "cursor-user", "-s", CURSOR_CLI_KEYCHAIN_SERVICE, "-w"],
      { timeout: 3_000, maxBuffer: 64 * 1024, encoding: "utf8" },
    );
    return stdout.trim() || null;
  } catch {
    // Missing, locked or denied credentials must not hide other available stores.
    // Never propagate command errors: they can contain captured credential output.
    return null;
  }
}
