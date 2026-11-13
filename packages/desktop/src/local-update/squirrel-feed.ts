import { constants } from "node:fs";
import { open, lstat, realpath, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";

/** Host-only signed candidate archive capability. Never constructed from IPC paths.
 * Native Squirrel still verifies the candidate against the running app's signing
 * requirement. This loopback feed does not replace signature/approval validation. */
export interface ApprovedLocalArchive {
  directory: string;
  sha512: string;
}
async function approvedSnapshot(file: FileHandle, expectedDigest: string) {
  const info = await file.stat();
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    info.nlink !== 1 ||
    info.mode & 0o022 ||
    info.size < 1 ||
    info.size > 512 * 1024 * 1024
  )
    throw Error("unsafe_local_archive_file");
  // Snapshot exactly the approved bytes in bounded memory. Holding an fd alone
  // does not stop another process from modifying that same inode in place.
  const payload = Buffer.allocUnsafe(info.size);
  let offset = 0;
  while (offset < payload.length) {
    const { bytesRead } = await file.read(payload, offset, payload.length - offset, offset);
    if (bytesRead === 0) throw Error("local_archive_changed");
    offset += bytesRead;
  }
  if (
    (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0 ||
    createHash("sha512").update(payload).digest("hex") !== expectedDigest
  )
    throw Error("local_archive_changed");
  return payload;
}

export async function startApprovedSquirrelFeed(archive: ApprovedLocalArchive) {
  if (!path.isAbsolute(archive.directory) || !/^[a-f0-9]{128}$/.test(archive.sha512))
    throw Error("invalid_local_archive");
  const directory = await lstat(archive.directory);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700 ||
    (await realpath(archive.directory)) !== archive.directory
  )
    throw Error("unsafe_local_archive_directory");
  const file = await open(
    path.join(archive.directory, "candidate.zip"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let server: ReturnType<typeof createServer> | undefined;
  try {
    let payload = await approvedSnapshot(file, archive.sha512);
    const size = payload.length;
    const secret = randomBytes(32).toString("hex");
    const archivePath = `/${randomBytes(32).toString("hex")}.zip`;
    const authorization = `Basic ${Buffer.from(`paseo:${secret}`).toString("base64")}`;
    let origin = "";
    let closed = false;
    server = createServer((request, response) => {
      const reject = (status: number) => {
        response.writeHead(status);
        response.end();
      };
      if (closed || request.method !== "GET" || request.socket.remoteAddress !== "127.0.0.1")
        return reject(403);
      if (request.url === "/") {
        const supplied = Buffer.from(request.headers.authorization ?? "");
        const expected = Buffer.from(authorization);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
          return reject(401);
        const json = Buffer.from(JSON.stringify({ url: origin + archivePath }));
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": json.length,
          "Cache-Control": "no-store",
        });
        response.end(json);
      } else if (request.url === archivePath) {
        // Squirrel does not forward the feed's Authorization header to ZIP requests.
        // Exact cryptographically random path is a local, per-run capability.
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": size,
          "Cache-Control": "no-store",
        });
        response.end(payload);
      } else reject(404);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("local_feed_address");
    origin = `http://127.0.0.1:${address.port}`;
    return {
      feed: { url: origin + "/", headers: { Authorization: authorization } },
      async close() {
        if (closed) return;
        closed = true;
        server!.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        await file.close();
        payload = Buffer.alloc(0);
      },
    };
  } catch (error) {
    server?.close();
    await file.close();
    throw error;
  }
}
