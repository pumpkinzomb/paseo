import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hash } from "./dev-update-store.mjs";
const exec = promisify(execFile);
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const pluginBefore =
  "npm --prefix ../../plugin-examples/markdown-panel install --ignore-scripts --no-audit --no-fund && tsgo -p tsconfig.examples.json --noEmit";

/** Explicit metadata-only proof. The sealed dependency payload is never rewritten/resealed. */
export async function proveDependencyMetadataEquivalence({
  source,
  donorRevision,
  expected,
  actual,
}) {
  const fail = () => {
    throw new Error("Dependency metadata equivalence rejected; installation inputs differ");
  };
  if (!equal(Object.keys(expected).sort(), Object.keys(actual).sort())) fail();
  const originals = new Map(),
    currents = new Map();
  for (const name of Object.keys(expected)) {
    if (expected[name].executable !== actual[name].executable) fail();
    const before = (
      await exec("git", ["show", `${donorRevision}:${name}`], {
        cwd: source,
        maxBuffer: 20 * 1024 ** 2,
      })
    ).stdout;
    if (hash(before) !== expected[name].sha256) fail();
    if (name.endsWith("package.json") || name.endsWith("package-lock.json")) {
      originals.set(name, JSON.parse(before));
      currents.set(name, JSON.parse(await fs.readFile(path.join(source, name), "utf8")));
    } else if (expected[name].sha256 !== actual[name].sha256) fail();
  }
  const donorRoot = originals.get("package.json"),
    currentRoot = currents.get("package.json");
  if (!Array.isArray(donorRoot.workspaces) || !equal(donorRoot.workspaces, currentRoot.workspaces))
    fail();
  const workspaceFiles = donorRoot.workspaces.map((workspace) => `${workspace}/package.json`);
  // This opt-in supports the repository's explicit workspace list only; never guess glob membership.
  if (workspaceFiles.some((file) => file.includes("*"))) fail();
  const ownFiles = ["package.json", ...workspaceFiles];
  const own = new Map();
  for (const file of ownFiles) {
    const old = originals.get(file),
      next = currents.get(file);
    if (
      !old?.name ||
      old.name !== next?.name ||
      own.has(old.name) ||
      typeof next.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(next.version)
    )
      fail();
    own.set(old.name, { before: old.version, after: next.version });
  }
  const deltas = [];
  function replace(object, key, value, file, field) {
    if (object[key] !== value) {
      deltas.push({ file, field, before: object[key], after: value });
      object[key] = value;
    }
  }
  function pins(object, file, prefix = "") {
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, versions] of own) {
        if (object[section]?.[name] === versions.before)
          replace(object[section], name, versions.after, file, `${prefix}${section}.${name}`);
      }
    }
  }
  function normalizeFile(file) {
    if (expected[file].sha256 === actual[file].sha256) return;
    const before = structuredClone(originals.get(file)),
      after = currents.get(file);
    if (!before || !after) fail();
    if (ownFiles.includes(file)) {
      replace(before, "version", after.version, file, "version");
      pins(before, file);
      if (
        file === "packages/plugin/package.json" &&
        before.scripts?.["typecheck:examples"] === pluginBefore &&
        after.scripts?.["typecheck:examples"] === "tsgo -p tsconfig.examples.json --noEmit"
      )
        replace(
          before.scripts,
          "typecheck:examples",
          after.scripts["typecheck:examples"],
          file,
          "scripts.typecheck:examples (reviewed installer removal)",
        );
    } else if (file.endsWith("package-lock.json")) {
      const manifestFile = file.replace("package-lock.json", "package.json");
      if (!ownFiles.includes(manifestFile)) fail();
      const version = currents.get(manifestFile).version;
      replace(before, "version", version, file, "version");
      for (const [key, record] of Object.entries(before.packages ?? {})) {
        // External/node_modules records, including local links, remain exact.
        if (key.split("/").includes("node_modules")) continue;
        const manifest = key ? `${key}/package.json` : manifestFile;
        if (!ownFiles.includes(manifest)) fail();
        replace(record, "version", currents.get(manifest).version, file, `packages.${key}.version`);
        pins(record, file, `packages.${key}.`);
      }
    } else fail();
    if (!equal(before, after)) fail();
  }
  for (const file of Object.keys(expected)) normalizeFile(file);
  const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  return { version: 1, donorRevision, revision, expected, actual, deltas };
}
