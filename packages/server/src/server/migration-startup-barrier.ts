import { lstat } from "node:fs/promises";
import path from "node:path";

const HOME_ACTIVATION_LEASE = ".home-activation-lease-v1";

// Durable presence, not PID liveness or journal contents, gates startup.
export const HOME_MIGRATION_PENDING_MARKER = ".home-migration-pending";

export async function assertNoPendingHomeMigration(paseoHome: string): Promise<void> {
  for (const marker of [HOME_MIGRATION_PENDING_MARKER, HOME_ACTIVATION_LEASE]) {
    try {
      // lstat also detects dangling symlinks. Never read/follow a marker payload.
      await lstat(path.join(paseoHome, marker));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Daemon startup blocked: pending home migration requires explicit recovery.");
  }
}

// Caller must already own paseo.pid; release only that owned lock on refusal.
export async function checkMigrationAfterPidLock(
  paseoHome: string,
  releaseOwnedPidLock: () => Promise<void>,
): Promise<void> {
  try {
    await assertNoPendingHomeMigration(paseoHome);
  } catch (error) {
    await releaseOwnedPidLock();
    throw error;
  }
}
