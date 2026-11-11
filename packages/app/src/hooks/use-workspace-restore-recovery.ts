import { useCallback, useEffect, useState } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export const WORKSPACE_RESTORE_TIMEOUT_MS = 30_000;

/** A saved host needs its own deadline: another online host disables the global
 * startup timeout. Never discard the saved selection just to finish startup. */
export function useWorkspaceRestoreRecovery(serverId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  const key = serverId ? `${serverId}:${attempt}` : null;

  useEffect(() => {
    if (!serverId || !key) return;
    let cancelled = false;
    const timer = setTimeout(() => setExpiredKey(key), WORKSPACE_RESTORE_TIMEOUT_MS);
    if (attempt > 0) {
      const runtime = getHostRuntimeStore();
      void runtime
        .runProbeCycleNow(serverId)
        .then(() => {
          if (!cancelled) return runtime.refreshDirectories(serverId);
          return undefined;
        })
        .catch(() => {
          if (!cancelled) setExpiredKey(key);
        });
    }
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [serverId, key, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { needsRecovery: key !== null && expiredKey === key, retry };
}
