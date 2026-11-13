import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, chmod, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { startApprovedSquirrelFeed } from "./squirrel-feed.js";
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-feed-")));
  const data = Buffer.from("fixture ZIP; native signature verification is separate");
  await writeFile(path.join(directory, "candidate.zip"), data, { mode: 0o600 });
  return {
    directory,
    data,
    sha512: createHash("sha512").update(data).digest("hex"),
    clean: () => rm(directory, { recursive: true, force: true }),
  };
}
it("serves only authenticated feed and exact opaque ZIP capability on loopback", async () => {
  const f = await fixture();
  const s = await startApprovedSquirrelFeed(f);
  try {
    expect(new URL(s.feed.url).hostname).toBe("127.0.0.1");
    expect((await fetch(s.feed.url)).status).toBe(401);
    const r = await fetch(s.feed.url, { headers: s.feed.headers });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { url: string };
    const zip = await fetch(body.url);
    expect(Buffer.from(await zip.arrayBuffer())).toEqual(f.data);
    expect((await fetch(body.url + "?extra")).status).toBe(404);
    expect((await fetch(s.feed.url, { method: "POST", headers: s.feed.headers })).status).toBe(403);
  } finally {
    await s.close();
    await s.close();
    await f.clean();
  }
});
it("rejects changed archive before binding a server", async () => {
  const f = await fixture();
  try {
    await expect(startApprovedSquirrelFeed({ ...f, sha512: "a".repeat(128) })).rejects.toThrow(
      "local_archive_changed",
    );
  } finally {
    await f.clean();
  }
});
it("rejects public staging directory and archive symlink", async () => {
  const f = await fixture();
  try {
    await chmod(f.directory, 0o755);
    await expect(startApprovedSquirrelFeed(f)).rejects.toThrow("unsafe_local_archive_directory");
    await chmod(f.directory, 0o700);
    await rm(path.join(f.directory, "candidate.zip"));
    await symlink("missing", path.join(f.directory, "candidate.zip"));
    await expect(startApprovedSquirrelFeed(f)).rejects.toThrow();
  } finally {
    await f.clean();
  }
});

it("serves approved snapshot even if the original inode is subsequently rewritten", async () => {
  const f = await fixture();
  const s = await startApprovedSquirrelFeed(f);
  try {
    await writeFile(path.join(f.directory, "candidate.zip"), "changed after approval");
    const response = await fetch(s.feed.url, { headers: s.feed.headers });
    const body = (await response.json()) as { url: string };
    expect(Buffer.from(await (await fetch(body.url)).arrayBuffer())).toEqual(f.data);
  } finally {
    await s.close();
    await f.clean();
  }
});
