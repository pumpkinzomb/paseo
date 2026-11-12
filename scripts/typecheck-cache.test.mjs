import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { reuseTypecheckCaches } from "./typecheck-cache.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "typecheck-cache-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    staging = path.join(root, "stage");
  await fs.mkdir(path.join(source, ".lab/typecheck"), { recursive: true });
  await fs.mkdir(staging);
  const data = JSON.stringify({
    version: "7",
    fileNames: ["../../src/a.ts"],
    fileInfos: [{ version: "hash" }],
    options: { strict: true },
  });
  await fs.writeFile(path.join(source, ".lab/typecheck/app.tsbuildinfo"), data);
  return {
    root,
    source,
    staging,
    data,
    options: { source, staging, revision: "abc" },
    ports: { isFrozenSource: async () => true },
  };
}

test("copies only known compiler cache JSON and records missing caches", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await reuseTypecheckCaches(f.options, f.ports), {
    copied: ["app.tsbuildinfo"],
    skipped: ["server.tsbuildinfo"],
  });
  assert.equal(
    await fs.readFile(path.join(f.staging, ".lab/typecheck/app.tsbuildinfo"), "utf8"),
    f.data,
  );
});
test("changed source never supplies cache", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await reuseTypecheckCaches(f.options, { isFrozenSource: async () => false })).reason,
    "source-not-frozen",
  );
  assert.equal(
    await fs.stat(path.join(f.staging, ".lab")).then(
      () => true,
      () => false,
    ),
    false,
  );
});
test("malformed or symlinked cache is ignored", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, ".lab/typecheck/app.tsbuildinfo"), "invalid");
  await fs.writeFile(path.join(f.root, "outside"), f.data);
  await fs.symlink(
    path.join(f.root, "outside"),
    path.join(f.source, ".lab/typecheck/server.tsbuildinfo"),
  );
  assert.deepEqual(await reuseTypecheckCaches(f.options, f.ports), {
    copied: [],
    skipped: ["app.tsbuildinfo", "server.tsbuildinfo"],
  });
});
test("existing destination is never overwritten", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.staging, ".lab/typecheck"), { recursive: true });
  await fs.writeFile(path.join(f.staging, ".lab/typecheck/app.tsbuildinfo"), "keep");
  assert.deepEqual((await reuseTypecheckCaches(f.options, f.ports)).copied, []);
  assert.equal(
    await fs.readFile(path.join(f.staging, ".lab/typecheck/app.tsbuildinfo"), "utf8"),
    "keep",
  );
});
test("destination symlink escaping staging fails closed", async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.source, path.join(f.staging, ".lab"));
  await assert.rejects(reuseTypecheckCaches(f.options, f.ports), /escaped staging/);
});

test("real compiler reuses a relocated cache and still reports changed source and dependency types", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const f = await fixture(t);
  await fs.unlink(path.join(f.source, ".lab/typecheck/app.tsbuildinfo"));
  await fs.writeFile(path.join(f.source, ".gitignore"), ".lab/\n");
  await fs.writeFile(path.join(f.source, "types.d.ts"), "export type Value = number;\n");
  await fs.writeFile(
    path.join(f.source, "index.ts"),
    "import type {Value} from './types'; const n: Value = 1;\n",
  );
  await fs.writeFile(
    path.join(f.source, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        incremental: true,
        tsBuildInfoFile: ".lab/typecheck/app.tsbuildinfo",
        types: [],
      },
      files: ["index.ts", "types.d.ts"],
    }),
  );
  await exec("git", ["init", "-q"], { cwd: f.source });
  await exec("git", ["add", "."], { cwd: f.source });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: f.source },
  );
  const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
  const toolRoot = process.env.PASEO_TYPECHECK_TEST_ROOT ?? path.resolve(import.meta.dirname, "..");
  const compile = (root) =>
    exec(
      "npm",
      [
        "run",
        "typecheck",
        "--workspace=@getpaseo/app",
        "--",
        "-p",
        path.join(root, "tsconfig.json"),
      ],
      { cwd: toolRoot, maxBuffer: 1024 * 1024 },
    );
  await compile(f.source);
  await exec("git", ["clone", "-q", f.source, f.staging]);
  assert.deepEqual((await reuseTypecheckCaches({ ...f.options, revision })).copied, [
    "app.tsbuildinfo",
  ]);
  await compile(f.staging);
  await fs.writeFile(path.join(f.staging, "index.ts"), "const n: number = 'wrong';\n");
  await assert.rejects(compile(f.staging), (error) => error.stdout.includes("TS2322"));
  await fs.writeFile(
    path.join(f.staging, "index.ts"),
    "import type {Value} from './types'; const n: Value = 1;\n",
  );
  await fs.writeFile(path.join(f.staging, "types.d.ts"), "export type Value = string;\n");
  await assert.rejects(compile(f.staging), (error) => error.stdout.includes("TS2322"));
});
