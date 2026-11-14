import type { UpdateControlPublication } from "./installed-update-control.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maximumBytes = 16_384;
export interface UpdateControlRequest {
  version: 1;
  id: string;
  operation: "prepare" | "inspect" | "abort" | "commit" | "renew" | "reclaimDependencies";
  daemonIdentity?: string;
  registryId?: string;
  evidence?: unknown;
  binding?: unknown;
  ticket?: unknown;
}
export interface UpdateControlDescriptor {
  version: 1;
  daemonIdentity: string;
  generation: string;
  workerPid: number;
  serverId: string;
  capabilities: {
    rendererLease: boolean;
    daemonCommit: boolean;
    managedDependencyRetirement?: boolean;
  };
  ttlMs: number;
  instance: {
    pid: number;
    startedAt: string;
    hostname: string;
    uid: number;
    bootId: string | null;
  };
}
async function privateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700 });
}
async function ensurePrivateDirectory(directory: string) {
  try {
    await privateDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Unsafe update control directory");
}
async function readPrivateJson(filename: string): Promise<unknown> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > maximumBytes ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe update control request");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
async function writePrivateJson(
  filename: string,
  value: unknown,
  publication?: UpdateControlPublication,
) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  if (!publication) {
    await rename(temporary, filename);
    return;
  }
  try {
    await publication.assertAuthority();
    if (!publication.isActive()) throw new Error("Installed control publication closed");
    // Linearize at rename issuance; disposal waits for this in-flight publication.
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}
/** Local same-user mailbox. No socket, RPC registration, credential or provider access. */
export async function startUpdateControl(options: {
  directory: string;
  descriptor: UpdateControlDescriptor;
  handle(request: UpdateControlRequest): Promise<unknown>;
  pollMs?: number;
  publication?: UpdateControlPublication;
}) {
  if (!path.isAbsolute(options.directory) || !uuid.test(options.descriptor.generation)) {
    throw new Error("Invalid update control path or generation");
  }
  await options.publication?.assertAuthority();
  await ensurePrivateDirectory(options.directory);
  const directory = path.join(options.directory, options.descriptor.generation);
  await ensurePrivateDirectory(directory);
  await ensurePrivateDirectory(path.join(directory, "requests"));
  await ensurePrivateDirectory(path.join(directory, "responses"));
  await writePrivateJson(
    path.join(options.directory, "descriptor.json"),
    options.descriptor,
    options.publication,
  );
  let closed = false;
  let running: Promise<void> | null = null;
  async function scan() {
    let handled = 0;
    for (const name of (await readdir(path.join(directory, "requests"))).sort()) {
      if (handled >= 128) break;
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!uuid.test(id) || closed) continue;
      const responsePath = path.join(directory, "responses", name);
      try {
        await lstat(responsePath);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      handled++;
      let response: unknown;
      try {
        const request = (await readPrivateJson(
          path.join(directory, "requests", name),
        )) as UpdateControlRequest;
        if (
          !request ||
          request.version !== 1 ||
          request.id !== id ||
          !["prepare", "inspect", "abort", "commit", "renew", "reclaimDependencies"].includes(
            request.operation,
          )
        )
          throw new Error("Invalid update request");
        response = {
          version: 1,
          id,
          ok: true,
          result: await options.handle(request),
        };
      } catch (error) {
        response = {
          version: 1,
          id,
          ok: false,
          error: {
            code: "update_blocked",
            message: error instanceof Error ? error.message : "Update control failure",
          },
        };
      }
      await writePrivateJson(responsePath, response);
    }
  }
  function poll() {
    if (closed) return Promise.resolve();
    if (!running)
      running = scan().finally(() => {
        running = null;
      });
    return running;
  }
  const timer = setInterval(() => {
    void poll().catch(() => undefined);
  }, options.pollMs ?? 100);
  timer.unref();
  return {
    directory,
    poll,
    async close() {
      closed = true;
      clearInterval(timer);
      // A hanging provider probe must not delay normal daemon shutdown.
      // Bootstrap revokes its lease first; late completions cannot authorize a cutover.
      void running?.catch(() => undefined);
      // Retain audit files and descriptor. Clients must bind the current PID lock;
      // never unlink a replacement descriptor after an asynchronous check.
    },
  };
}
