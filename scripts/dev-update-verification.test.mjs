import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hash, hashFile, mapVerification, scanRelease } from "./dev-update-store.mjs";

test("verification is bounded, ordered, and drains on failure", async () => {
  let active = 0,
    peak = 0;
  const values = await mapVerification(
    Array.from({ length: 20 }, (_, i) => i),
    async (i) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, (i % 3) + 1));
      active--;
      return i;
    },
  );
  assert.deepEqual(
    values,
    Array.from({ length: 20 }, (_, i) => i),
  );
  assert.equal(peak, 4);
  await assert.rejects(
    mapVerification([0, 1, 2, 3, 4], async (i) => {
      active++;
      await new Promise((r) => setTimeout(r, i === 0 ? 1 : 10));
      active--;
      if (i === 0) throw Error("changed");
    }),
    /changed/,
  );
  assert.equal(active, 0);
  await assert.rejects(
    mapVerification([], () => {}, 0),
    /concurrency/,
  );
});

test("streaming hash reads all chunks and scans preserve depth-first manifest order", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paseo-verification-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "a"));
  const data = Buffer.alloc(1024 * 1024 + 17, 71);
  await fs.writeFile(path.join(root, "a", "z"), data);
  await fs.writeFile(path.join(root, "a.js"), "small");
  await fs.writeFile(path.join(root, "empty"), "");
  assert.equal(await hashFile(path.join(root, "a", "z")), hash(data));
  const first = await scanRelease(root);
  assert.deepEqual(Object.keys(first), ["a/z", "a.js", "empty"]);
  assert.equal(first.empty.sha256, hash(""));
  const original = await fs.stat(path.join(root, "a", "z"));
  data[data.length - 1] = 72;
  await fs.writeFile(path.join(root, "a", "z"), data);
  await fs.utimes(path.join(root, "a", "z"), original.atime, original.mtime);
  const second = await scanRelease(root);
  assert.notEqual(second["a/z"].sha256, first["a/z"].sha256);
  await fs.symlink("a/z", path.join(root, "link"));
  await assert.rejects(hashFile(path.join(root, "link")));
});
