export interface ShutdownQuiescenceSnapshot {
  state: "not-started" | "stopping" | "returned" | "failed";
  quiescent: false;
  failures: string[];
  unverified: string[];
}

/** Diagnostics, never an authority to release a migration lease. */
export function createShutdownQuiescenceTracker() {
  let state: ShutdownQuiescenceSnapshot["state"] = "not-started";
  const failures = new Set<string>();
  return {
    begin() {
      state = "stopping";
    },
    failure(component: string) {
      failures.add(component);
    },
    finish(success: boolean) {
      state = success ? "returned" : "failed";
    },
    snapshot(): ShutdownQuiescenceSnapshot {
      return {
        state,
        quiescent: false,
        failures: [...failures],
        unverified: [
          "registry-and-session-writer-coverage",
          "timed-out-agent-close-and-plugin-events",
        ],
      };
    },
  };
}
