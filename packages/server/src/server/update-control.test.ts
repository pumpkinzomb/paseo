import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startUpdateControl } from "./update-control.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-update-control-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const descriptor = {
    version: 1 as const,
    daemonIdentity: "fixture",
    generation: randomUUID(),
    workerPid: process.pid,
    serverId: "isolated",
    instance: {
      pid: process.pid,
      startedAt: "fixture",
      hostname: "fixture",
      uid: process.getuid!(),
      bootId: null,
    },
    capabilities: { rendererLease: true, daemonCommit: false },
    ttlMs: 15000,
  };
  const handle = vi.fn(async (request: { operation: string }) => ({
    operation: request.operation,
  }));
  const control = await startUpdateControl({
    directory: path.join(root, "control"),
    descriptor,
    handle,
    pollMs: 60000,
  });
  cleanups.push(() => control.close());
  return { root, descriptor, handle, control };
}
it("uses private generation mailboxes and processes each request once", async () => {
  const f = await fixture();
  const id = randomUUID();
  await writeFile(
    path.join(f.control.directory, "requests", `${id}.json`),
    JSON.stringify({ version: 1, id, operation: "inspect", ticket: {} }),
    { mode: 0o600 },
  );
  await f.control.poll();
  await f.control.poll();
  const response = JSON.parse(
    await readFile(path.join(f.control.directory, "responses", `${id}.json`), "utf8"),
  );
  expect(response).toEqual({
    version: 1,
    id,
    ok: true,
    result: { operation: "inspect" },
  });
  expect(f.handle).toHaveBeenCalledTimes(1);
  expect((await stat(f.control.directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(f.control.directory, "responses", `${id}.json`))).mode & 0o777).toBe(
    0o600,
  );
});
it("rejects symlink requests, oversized requests and mismatched ids without dispatch", async () => {
  const f = await fixture();
  const target = path.join(f.root, "target");
  await writeFile(target, "{}", { mode: 0o600 });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  await symlink(target, path.join(f.control.directory, "requests", `${ids[0]}.json`));
  await writeFile(path.join(f.control.directory, "requests", `${ids[1]}.json`), "x".repeat(17000), {
    mode: 0o600,
  });
  await writeFile(
    path.join(f.control.directory, "requests", `${ids[2]}.json`),
    JSON.stringify({ version: 1, id: randomUUID(), operation: "commit" }),
    { mode: 0o600 },
  );
  await f.control.poll();
  expect(f.handle).not.toHaveBeenCalled();
  for (const id of ids)
    expect(
      JSON.parse(await readFile(path.join(f.control.directory, "responses", `${id}.json`), "utf8"))
        .ok,
    ).toBe(false);
});
it("refuses a preexisting public directory without changing its permissions", async () => {
  const f = await fixture();
  const publicDir = path.join(f.root, "public");
  await mkdir(publicDir, { mode: 0o755 });
  await expect(
    startUpdateControl({
      directory: publicDir,
      descriptor: f.descriptor,
      handle: f.handle,
    }),
  ).rejects.toThrow("Unsafe");
  expect((await stat(publicDir)).mode & 0o777).toBe(0o755);
});
