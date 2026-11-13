import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNoPendingHomeMigration,
  checkMigrationAfterPidLock,
  HOME_MIGRATION_PENDING_MARKER,
} from "./migration-startup-barrier.ts";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-barrier-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, marker: path.join(home, HOME_MIGRATION_PENDING_MARKER) };
}

test("absent marker permits startup without releasing owned lock", async (t) => {
  const { home } = fixture(t);
  let released = false;
  await checkMigrationAfterPidLock(home, async () => {
    released = true;
  });
  assert.equal(released, false);
});

for (const type of ["file", "directory", "dangling symlink"]) {
  test(`${type} pending marker blocks and survives startup refusal`, async (t) => {
    const { home, marker } = fixture(t);
    if (type === "file") fs.writeFileSync(marker, '{"state":"committed","pid":0}');
    else if (type === "directory") fs.mkdirSync(marker);
    else fs.symlinkSync(path.join(home, "missing"), marker);
    let releases = 0;
    await assert.rejects(
      checkMigrationAfterPidLock(home, async () => {
        releases++;
      }),
      /pending home migration/,
    );
    assert.equal(releases, 1);
    assert.ok(fs.lstatSync(marker));
    await assert.rejects(assertNoPendingHomeMigration(home), /pending home migration/);
  });
}

test("filesystem errors fail closed and release is attempted", async (t) => {
  const { home } = fixture(t);
  const notDirectory = path.join(home, "file");
  fs.writeFileSync(notDirectory, "x");
  let released = false;
  await assert.rejects(
    checkMigrationAfterPidLock(notDirectory, async () => {
      released = true;
    }),
    { code: "ENOTDIR" },
  );
  assert.equal(released, true);
});

test("entrypoint source contracts gate supervisor and direct worker", () => {
  const supervisor = fs.readFileSync(
    new URL("../../scripts/supervisor-entrypoint.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    supervisor.indexOf("await acquirePidLock(") <
      supervisor.indexOf("await checkMigrationAfterPidLock("),
  );
  assert.ok(
    supervisor.indexOf("await checkMigrationAfterPidLock(") <
      supervisor.indexOf("const supervisor = runSupervisor("),
  );
  assert.match(
    supervisor,
    /checkMigrationAfterPidLock\(paseoHome, \(\) =>\s*releasePidLock\(paseoHome, \{ ownerPid: process.pid \}\)/,
  );
  const worker = fs.readFileSync(new URL("./daemon-worker.ts", import.meta.url), "utf8");
  assert.ok(
    worker.indexOf("assertNoPendingHomeMigration(paseoHome)") <
      worker.indexOf("loadConfig(paseoHome)"),
  );
});

test("desktop/CLI launcher and direct factory gate before side effects", () => {
  const launcher = fs.readFileSync(new URL("./daemon-instance.ts", import.meta.url), "utf8");
  const start = launcher.slice(launcher.indexOf("export async function startDaemonInstance"));
  assert.ok(start.indexOf("await assertNoPendingHomeMigration(input.home)") >= 0);
  assert.ok(
    start.indexOf("await assertNoPendingHomeMigration(input.home)") <
      start.indexOf("const child = spawn("),
  );
  const bootstrap = fs.readFileSync(new URL("./bootstrap.ts", import.meta.url), "utf8");
  const factory = bootstrap.slice(bootstrap.indexOf("export async function createPaseoDaemon("));
  assert.ok(
    factory.indexOf("await assertNoPendingHomeMigration(config.paseoHome)") <
      factory.indexOf("return createPaseoDaemonInternal("),
  );
});
