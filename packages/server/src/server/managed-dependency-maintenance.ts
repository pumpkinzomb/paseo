import path from "node:path";
import { pathToFileURL } from "node:url";
import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import { UpdateBlocked, type createUpdateQuiescence } from "./update-quiescence.js";

const requestSchema = z
  .object({
    daemonIdentity: z.string(),
    registryId: z.string().regex(/^[a-f0-9]{64}$/),
    evidence: z
      .object({
        sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
        releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export interface PreparedDependencyRetirement {
  root: string;
  commitSync(): { transactionId: string; [key: string]: unknown };
  purge(): Promise<unknown>;
  abortSync(): void;
}
export type PrepareManagedDetach = (
  registry: string,
  id: string,
  evidence: { sourceRevision: string; releaseDigest: string },
) => Promise<PreparedDependencyRetirement>;

/** Load only a sibling of the supervisor-supplied setup helper, never a request path. */
export async function loadManagedDetachHelper(helper: string): Promise<PrepareManagedDetach> {
  if (
    !path.isAbsolute(helper) ||
    path.resolve(helper) !== helper ||
    (await realpath(helper)) !== helper
  )
    throw new UpdateBlocked("Invalid trusted worktree setup helper");
  const file = path.join(path.dirname(helper), "managed-worktree-retirement.mjs");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file)
    throw new UpdateBlocked("Invalid trusted retirement helper");
  const module = await import(pathToFileURL(file).href);
  if (typeof module.prepareManagedDetach !== "function")
    throw new UpdateBlocked("Retirement helper unavailable");
  return module.prepareManagedDetach as PrepareManagedDetach;
}

export async function reclaimManagedDependencies(
  input: unknown,
  options: {
    daemonIdentity: string;
    registry: string;
    prepare: PrepareManagedDetach;
    quiescence: ReturnType<typeof createUpdateQuiescence>;
    /** Synchronous check: terminal worker availability and every retained PTY. */
    assertNoTerminals(): void;
    onPurgeError(error: unknown): void;
  },
) {
  const request = requestSchema.parse(input);
  if (request.daemonIdentity !== options.daemonIdentity)
    throw new UpdateBlocked("Daemon instance changed");
  if (!path.isAbsolute(options.registry)) throw new UpdateBlocked("Managed registry unavailable");
  // Hashing/verification happens before the short lease; it cannot expire during a large scan.
  const prepared = await options.prepare(options.registry, request.registryId, request.evidence);
  let result: ReturnType<PreparedDependencyRetirement["commitSync"]>;
  try {
    options.assertNoTerminals();
    const ticket = await options.quiescence.prepare({
      mode: "renderer",
      daemonIdentity: request.daemonIdentity,
      candidateDigest: request.evidence.releaseDigest,
    });
    try {
      await options.quiescence.commit(ticket);
      result = options.quiescence.runSynchronousMaintenance(ticket, () => {
        options.assertNoTerminals();
        // No await between final admission/PTY checks and atomic filesystem detach.
        return prepared.commitSync();
      });
    } finally {
      try {
        options.quiescence.abort(ticket);
      } catch {
        /* Already revoked/expired. */
      }
    }
  } finally {
    // Preparation holds the dependency setup lock even when lease acquisition is denied.
    prepared.abortSync();
  }
  void prepared.purge().catch(options.onPurgeError);
  return {
    detached: true,
    transactionId: result.transactionId,
    root: prepared.root,
    purgePending: true,
  };
}
