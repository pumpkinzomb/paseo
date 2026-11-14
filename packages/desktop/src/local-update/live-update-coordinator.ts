import type { LocalUpdateDriver } from "./ipc.js";

export interface InstalledUpdateCoordinator {
  driver: LocalUpdateDriver;
  resumeIfPending(): Promise<void>;
}

/** Refresh offers, never execute startup recovery as a side effect of polling. */
export async function createLiveUpdateCoordinator({
  readApprovalKey,
  createCoordinator,
  currentVersion,
}: {
  readApprovalKey(): Promise<string | null>;
  createCoordinator(): Promise<InstalledUpdateCoordinator | null>;
  currentVersion: string;
}): Promise<InstalledUpdateCoordinator> {
  let key = await readApprovalKey();
  let coordinator = await createCoordinator();
  if ((await readApprovalKey()) !== key) throw Error("Update approval changed during discovery");
  // Serialize selection and application, including overlapping renderer polls.
  // A candidate can never be swapped out underneath an admitted request.
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async function refresh() {
    const nextKey = await readApprovalKey();
    if (nextKey === key) return;
    if (coordinator) {
      const status = await coordinator.driver.readStatus();
      // Unknown/irreversible outcomes keep the original coordinator and its fence.
      if (status.phase === "applying" || status.phase === "failed") return;
    }
    const next = await createCoordinator();
    if ((await readApprovalKey()) !== nextKey)
      throw Error("Update approval changed during discovery");
    coordinator = next;
    key = nextKey;
  }
  return {
    resumeIfPending: () => exclusive(async () => coordinator?.resumeIfPending()),
    driver: {
      readStatus: () =>
        exclusive(async () => {
          await refresh();
          return coordinator
            ? coordinator.driver.readStatus()
            : { currentVersion, phase: "idle" as const };
        }),
      requestUpdate: (token) =>
        exclusive(async () => {
          await refresh();
          if (!coordinator) throw Error("No approved installed update");
          const status = await coordinator.driver.readStatus();
          if (status.phase !== "idle" || status.candidate?.token !== token)
            throw Error("Local update candidate is no longer available");
          await coordinator.driver.requestUpdate(token);
        }),
    },
  };
}
