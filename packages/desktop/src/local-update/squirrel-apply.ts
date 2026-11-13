import { startApprovedSquirrelFeed, type ApprovedLocalArchive } from "./squirrel-feed.js";
export interface NativeSquirrel {
  once(event: "error" | "update-downloaded", listener: (...args: unknown[]) => void): unknown;
  removeListener(
    event: "error" | "update-downloaded",
    listener: (...args: unknown[]) => void,
  ): unknown;
  setFeedURL(feed: { url: string; headers: Record<string, string> }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}
/** Called only after an explicit update action has acquired its durable scoped
 * handoff. Native checkForUpdates is a commit, NOT a passive status check: native
 * Squirrel may install on subsequent app quit once it has prepared a candidate.
 * Do not register this with renderer IPC before daemon handoff validation exists. */
export async function requestNativeSquirrelInstall(input: {
  updater: NativeSquirrel;
  archive: ApprovedLocalArchive;
  /** Recheck exact user token, current/candidate identities, owner/home/server and
   * durable idle/stop/recovery state immediately before committing native update. */
  assertDurableHandoffReady(): Promise<void>;
  recordNativeCommit(): Promise<void>;
}) {
  const server = await startApprovedSquirrelFeed(input.archive);
  try {
    await input.assertDurableHandoffReady();
    await input.recordNativeCommit();
  } catch (error) {
    await server.close();
    throw error;
  }
  return new Promise<{ state: "handoff-requested" }>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      input.updater.removeListener("error", failed);
      input.updater.removeListener("update-downloaded", downloaded);
    };
    const failed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void server.close().then(() => reject(Error("native_squirrel_failed")), reject);
    };
    const downloaded = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void server.close().then(() => {
        try {
          input.updater.quitAndInstall();
          // This is not proof of replacement/relaunch. New bootstrap must consume
          // the durable handoff and verify its own revision + daemon connection.
          return resolve({ state: "handoff-requested" });
        } catch (error) {
          return reject(error);
        }
      }, reject);
    };
    input.updater.once("error", failed);
    input.updater.once("update-downloaded", downloaded);
    try {
      input.updater.setFeedURL(server.feed);
      input.updater.checkForUpdates();
    } catch {
      failed();
    }
  });
}
