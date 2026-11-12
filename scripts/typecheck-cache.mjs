import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inside } from "./dev-update-store.mjs";

const exec = promisify(execFile);
export const typecheckCaches = ["app.tsbuildinfo", "server.tsbuildinfo"];

async function isFrozenSource(source, revision) {
  const git = async (...args) => (await exec("git", args, { cwd: source })).stdout.trim();
  return (
    (await git("rev-parse", "HEAD")) === revision && (await git("status", "--porcelain")) === ""
  );
}

async function cacheDestination(sourceRoot, staging) {
  const stageRoot = await fs.realpath(staging);
  if (stageRoot === sourceRoot || inside(sourceRoot, stageRoot) || inside(stageRoot, sourceRoot))
    throw new Error("Source and staging must be independent");
  let destination = stageRoot;
  for (const part of [".lab", "typecheck"]) {
    destination = path.join(destination, part);
    try {
      await fs.mkdir(destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (
      !(await fs.lstat(destination)).isDirectory() ||
      (await fs.realpath(destination)) !== destination
    )
      throw new Error("Typecheck cache destination escaped staging");
  }
  return destination;
}

// This copies only compiler-produced JSON. It never records a successful check or
// skips a command: tsgo rechecks source/dependency hashes, options and its version.
export async function reuseTypecheckCaches({ source, staging, revision }, ports = {}) {
  const result = { copied: [], skipped: [] };
  if (!(await (ports.isFrozenSource ?? isFrozenSource)(source, revision)))
    return { ...result, reason: "source-not-frozen" };
  const sourceRoot = await fs.realpath(source);
  const destination = await cacheDestination(sourceRoot, staging);
  for (const name of typecheckCaches) {
    const file = path.join(sourceRoot, ".lab", "typecheck", name);
    try {
      const info = await fs.lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 16 * 1024 ** 2 ||
        !inside(sourceRoot, await fs.realpath(file))
      ) {
        result.skipped.push(name);
        continue;
      }
      const bytes = await fs.readFile(file);
      const data = JSON.parse(bytes);
      if (
        typeof data.version !== "string" ||
        !Array.isArray(data.fileNames) ||
        !Array.isArray(data.fileInfos) ||
        !data.options
      ) {
        result.skipped.push(name);
        continue;
      }
      await fs.writeFile(path.join(destination, name), bytes, { flag: "wx", mode: 0o600 });
      result.copied.push(name);
    } catch (error) {
      if (
        ["ENOENT", "EEXIST", "EACCES", "EPERM"].includes(error.code) ||
        error instanceof SyntaxError
      )
        result.skipped.push(name);
      else throw error;
    }
  }
  return result;
}
