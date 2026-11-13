import { EventEmitter } from "node:events";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { requestNativeSquirrelInstall } from "./squirrel-apply.js";
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-native-feed-")));
  const bytes = Buffer.from("signed bundle verified by native fixture separately");
  await writeFile(path.join(directory, "candidate.zip"), bytes, { mode: 0o600 });
  return {
    archive: { directory, sha512: createHash("sha512").update(bytes).digest("hex") },
    clean: () => rm(directory, { recursive: true, force: true }),
  };
}
class Native extends EventEmitter {
  events: string[] = [];
  fail = false;
  setFeedURL() {
    this.events.push("feed");
  }
  checkForUpdates() {
    this.events.push("check");
    queueMicrotask(() => this.emit(this.fail ? "error" : "update-downloaded"));
  }
  quitAndInstall() {
    this.events.push("quit");
  }
}
it("durable exact handoff precedes native commitment, reports only handoff", async () => {
  const f = await fixture(),
    updater = new Native();
  try {
    expect(
      await requestNativeSquirrelInstall({
        updater,
        archive: f.archive,
        async assertDurableHandoffReady() {
          updater.events.push("validate");
        },
        async recordNativeCommit() {
          updater.events.push("durable");
        },
      }),
    ).toEqual({ state: "handoff-requested" });
    expect(updater.events).toEqual(["validate", "durable", "feed", "check", "quit"]);
  } finally {
    await f.clean();
  }
});
it("unready daemon capability never starts native download or quits", async () => {
  const f = await fixture(),
    updater = new Native();
  try {
    await expect(
      requestNativeSquirrelInstall({
        updater,
        archive: f.archive,
        async assertDurableHandoffReady() {
          throw Error("not-ready");
        },
        async recordNativeCommit() {
          throw Error("must-not-run");
        },
      }),
    ).rejects.toThrow("not-ready");
    expect(updater.events).toEqual([]);
  } finally {
    await f.clean();
  }
});
it("native archive rejection does not quit or automatically retry", async () => {
  const f = await fixture(),
    updater = new Native();
  updater.fail = true;
  try {
    await expect(
      requestNativeSquirrelInstall({
        updater,
        archive: f.archive,
        async assertDurableHandoffReady() {},
        async recordNativeCommit() {},
      }),
    ).rejects.toThrow("native_squirrel_failed");
    expect(updater.events).toEqual(["feed", "check"]);
  } finally {
    await f.clean();
  }
});
