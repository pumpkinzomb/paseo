import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
const identity = z
  .object({
    uid: z.number().int().nonnegative(),
    home: z.string(),
    serverId: z.string().min(1),
    pid: z.number().int().positive(),
    startedAt: z.string().min(1),
    listen: z.string().regex(/^(127\.0\.0\.1|\[::1\]):[0-9]+$/),
    version: z.string().min(1),
  })
  .strict();
const capability = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().regex(/^[a-f0-9]{32}$/),
    oldRevision: z.string().regex(/^[a-f0-9]{40}$/),
    nextRevision: z.string().regex(/^[a-f0-9]{40}$/),
    nextVersion: z.string().min(1),
    original: identity,
  })
  .strict();
const approval = z
  .object({
    schemaVersion: z.literal(1),
    candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    capability,
  })
  .strict();
async function directory(p: string, uid: number) {
  const s = await lstat(p);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== uid ||
    (s.mode & 0o777) !== 0o700 ||
    (await realpath(p)) !== p
  )
    throw Error("Untrusted update authority directory");
}
async function read(p: string, uid: number) {
  const f = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== uid ||
      (s.mode & 0o777) !== 0o600 ||
      s.size > 8192
    )
      throw Error("Untrusted update authority record");
    return JSON.parse(await f.readFile("utf8"));
  } finally {
    await f.close();
  }
}
/** Same-user local approval, minted only by trusted app after signature and user
 * approval checks. This is not a remote endpoint or general daemon-stop grant. */
export async function verifyInstalledUpdateApproval(input: {
  userHome: string;
  current: z.infer<typeof identity>;
  candidateDigest: string;
  requireHold: boolean;
}) {
  const uid = process.getuid!();
  if (input.current.uid !== uid) throw Error("Update owner mismatch");
  const root = path.join(input.userHome, ".paseo-installed");
  await directory(root, uid);
  const dir = path.join(root, "daemon-update-v1");
  await directory(dir, uid);
  const value = approval.parse(await read(path.join(dir, "approval.json"), uid));
  if (
    value.candidateDigest !== input.candidateDigest ||
    value.capability.oldRevision === value.capability.nextRevision ||
    Object.keys(input.current).some(
      (k) =>
        value.capability.original[k as keyof typeof input.current] !==
        input.current[k as keyof typeof input.current],
    )
  )
    throw Error("Update approval does not bind current instance");
  if (input.requireHold) {
    const hold = capability.parse(await read(path.join(dir, "hold.json"), uid));
    if (JSON.stringify(hold) !== JSON.stringify(value.capability))
      throw Error("Update hold mismatch");
  }
  return value;
}
