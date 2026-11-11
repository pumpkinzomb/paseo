import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { hash, inside, verifyRelease } from "./dev-update-store.mjs";

const exec = promisify(execFile);
const dependencyPath = (name) => /(^|\/)node_modules\//.test(name);
const cachePath = (name) => /(^|\/)node_modules\/\.(cache|vite)\//.test(name);
export function isDependencyInput(name) {
  if (dependencyPath(name)) return false;
  return (
    /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?)$/.test(
      name,
    ) ||
    /(^|\/)patches\//.test(name) ||
    /(^|\/)(?:\.?lefthook(?:-local)?\.(?:yml|yaml|json|toml))$/.test(name) ||
    name.startsWith(".lefthook/") ||
    name === "scripts/postinstall-patches.mjs"
  );
}
function safeRelative(name) {
  if (
    path.isAbsolute(name) ||
    name.includes("\\") ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Unsafe dependency path");
  return name;
}
export async function dependencyInputs(source) {
  const files = (
    await exec("git", ["ls-files", "-z"], { cwd: source, maxBuffer: 20 * 1024 ** 2 })
  ).stdout
    .split("\0")
    .filter(Boolean);
  const result = {};
  for (const name of files.filter(isDependencyInput).sort()) {
    const info = await fs.lstat(path.join(source, safeRelative(name)));
    if (!info.isFile()) throw new Error(`Dependency input is not a regular file: ${name}`);
    result[name] = {
      sha256: hash(await fs.readFile(path.join(source, name))),
      executable: Boolean(info.mode & 0o111),
    };
  }
  if (!result["package.json"] || !result["package-lock.json"])
    throw new Error("Frozen package.json and package-lock.json are required");
  // This repository's only dependency-mutating lifecycle hook is reviewed here.
  // A new/custom hook needs a clean install, not guessed transitive script inputs.
  for (const name of files.filter(
    (file) => !dependencyPath(file) && /(^|\/)package\.json$/.test(file),
  )) {
    const pkg = JSON.parse(await fs.readFile(path.join(source, name), "utf8"));
    for (const hook of [
      "preinstall",
      "install",
      "postinstall",
      "prepublish",
      "preprepare",
      "prepare",
      "postprepare",
    ])
      if (
        pkg.scripts?.[hook] &&
        !(
          name === "package.json" &&
          ((hook === "postinstall" &&
            pkg.scripts[hook] === "node scripts/postinstall-patches.mjs") ||
            (hook === "prepare" && pkg.scripts[hook] === "lefthook install --force"))
        )
      )
        throw Object.assign(new Error(`Unreviewed dependency lifecycle hook: ${name} ${hook}`), {
          code: "UNREVIEWED_INSTALL_HOOK",
        });
  }
  return result;
}
export async function assertDiskReserve(root, minFreeBytes, extraBytes = 0) {
  if (!Number.isFinite(minFreeBytes) || minFreeBytes < 0)
    throw new Error("Invalid staging disk reserve");
  const stats = await fs.statfs(root);
  if (stats.bavail * stats.bsize < minFreeBytes + extraBytes)
    throw new Error("Insufficient dependency clone disk reserve");
}
async function ensureParents(root, relative) {
  const parts = relative.split("/").slice(0, -1);
  let directory = root;
  for (const name of parts) {
    directory = path.join(directory, name);
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (!(await fs.lstat(directory)).isDirectory() || (await fs.realpath(directory)) !== directory)
      throw new Error("Dependency destination traverses an alias");
  }
}
// Node's FICLONE_FORCE is ENOSYS on some macOS Node versions. clonefile(2)
// is the same strict CoW primitive; there is deliberately no full-copy fallback.
const macClone = String.raw`
import ctypes, json, os, sys
plan=json.loads(sys.stdin.read())
lib=ctypes.CDLL(None,use_errno=True)
clone=lib.clonefile
clone.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_int]
clone.restype=ctypes.c_int
for i,p in enumerate(plan['files']):
 if i % 256 == 0:
  s=os.statvfs(plan['destination'])
  if s.f_bavail*s.f_frsize < plan['reserve']: raise RuntimeError('Dependency clone reserve exhausted')
 if clone(os.fsencode(p[0]),os.fsencode(p[1]),0)!=0:
  n=ctypes.get_errno(); raise OSError(n,os.strerror(n),p[1])
 a=os.stat(p[0]); b=os.stat(p[1])
 if (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino) or b.st_nlink!=1: raise RuntimeError('Dependency clone is not independent')
`;
export function runNativeClone(plan, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("/usr/bin/python3", ["-I", "-c", macClone], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "",
      failure;
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-4096);
    });
    // An input-pipe failure is not proof that the clone writer has exited.
    // Node emits close after spawn failure too; no cleanup may run before it.
    child.once("error", (error) => {
      failure ??= error;
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      if (failure || code !== 0) {
        reject(new Error(`Strict native dependency clone failed: ${failure?.message ?? stderr}`));
        return;
      }
      resolve();
    });
    child.stdin.end(JSON.stringify(plan));
  });
}
export async function cloneDependencyEntries(options) {
  for (const name of Object.keys(options.entries)) {
    if (!dependencyPath(name) || cachePath(name)) throw new Error("Non-dependency clone entry");
  }
  return cloneVerifiedReleaseEntries(options);
}

// Caller verifies the sealed manifest first. Clone every listed entry, including
// caches needed for exact renderer-only comparisons, with no copy fallback.
export async function cloneVerifiedReleaseEntries({ source, destination, entries, minFreeBytes }) {
  source = await fs.realpath(source);
  if (
    (await fs.realpath(destination)) !== path.resolve(destination) ||
    source === destination ||
    inside(source, destination) ||
    inside(destination, source)
  )
    throw new Error("Dependency clone roots overlap or alias");
  const names = Object.keys(entries).sort();
  // Budget metadata, not the donor's full logical payload. CoW must succeed.
  await assertDiskReserve(destination, minFreeBytes, names.length * 8192);
  const files = [],
    links = [];
  for (const name of names) {
    safeRelative(name);
    await ensureParents(destination, name);
    const target = path.join(destination, name);
    try {
      await fs.lstat(target);
      throw new Error(`Dependency destination exists: ${name}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const entry = entries[name];
    if (entry.link !== undefined) {
      if (
        path.isAbsolute(entry.link) ||
        !inside(source, path.resolve(path.dirname(path.join(source, name)), entry.link))
      )
        throw new Error("Dependency link escapes donor");
      links.push([entry.link, target]);
    } else files.push([path.join(source, name), target]);
  }
  if (process.platform === "darwin") {
    await runNativeClone({ files, destination, reserve: minFreeBytes });
  } else {
    for (let i = 0; i < files.length; i++) {
      if (i % 256 === 0) await assertDiskReserve(destination, minFreeBytes);
      await fs.copyFile(
        files[i][0],
        files[i][1],
        constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL,
      );
    }
  }
  for (const [link, target] of links) await fs.symlink(link, target);
  await verifyDependencyEntries(destination, entries, source);
}
export async function verifyDependencyEntries(root, entries, donorRoot) {
  for (const [name, expected] of Object.entries(entries)) {
    const file = path.join(root, safeRelative(name)),
      info = await fs.lstat(file);
    if (expected.link !== undefined) {
      if (!info.isSymbolicLink() || (await fs.readlink(file)) !== expected.link)
        throw new Error(`Dependency link changed: ${name}`);
    } else {
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        Boolean(info.mode & 0o111) !== expected.executable ||
        hash(await fs.readFile(file)) !== expected.sha256
      )
        throw new Error(`Dependency payload changed: ${name}`);
      if (donorRoot) {
        const donor = await fs.lstat(path.join(donorRoot, name));
        if (donor.dev === info.dev && donor.ino === info.ino)
          throw new Error("Dependency files share an inode");
      }
    }
  }
}
export async function prepareDependencies({
  source,
  releases,
  donor,
  allowInstall = false,
  minFreeBytes = 8 * 1024 ** 3,
  verify = verifyRelease,
  clone = cloneDependencyEntries,
}) {
  if (!donor) {
    if (!allowInstall)
      throw new Error(
        "Provide --dependency-release and --dependency-digest, or explicitly --install-dependencies for a necessary clean install",
      );
    await assertDiskReserve(source, minFreeBytes);
    return { mode: "install" };
  }
  const verified = await verify(releases, donor.id, donor.digest);
  let actual;
  try {
    actual = await dependencyInputs(source);
  } catch (error) {
    if (!allowInstall || error.code !== "UNREVIEWED_INSTALL_HOOK") throw error;
    await assertDiskReserve(source, minFreeBytes);
    return { mode: "install", reason: "dependency-lifecycle-changed" };
  }
  // Manifest scans include generated dist/package.json files. Only tracked source
  // inputs of the donor commit describe the install that produced its payload.
  let donorTree;
  try {
    donorTree = (
      await exec("git", ["ls-tree", "-rz", "--name-only", verified.manifest.sourceRevision], {
        cwd: source,
        maxBuffer: 20 * 1024 ** 2,
      })
    ).stdout;
  } catch (error) {
    throw new Error(
      "Verified donor commit is unavailable in frozen source history; import that exact approved commit before staging",
      { cause: error },
    );
  }
  const donorFiles = donorTree.split("\0").filter(isDependencyInput);
  const expected = {};
  for (const name of donorFiles) {
    const entry = verified.manifest.entries[name];
    if (!entry?.sha256) throw new Error(`Donor dependency input missing: ${name}`);
    expected[name] = entry;
  }
  const canonical = (value) =>
    JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    );
  if (canonical(actual) !== canonical(expected)) {
    if (!allowInstall)
      throw new Error("Dependency inputs changed; explicitly allow a necessary clean install");
    await assertDiskReserve(source, minFreeBytes);
    return { mode: "install", reason: "dependency-inputs-changed" };
  }
  const entries = Object.fromEntries(
    Object.entries(verified.manifest.entries).filter(
      ([name]) => dependencyPath(name) && !cachePath(name),
    ),
  );
  if (!Object.keys(entries).length) throw new Error("Verified donor has no dependency artifacts");
  try {
    await clone({ source: verified.root, destination: source, entries, minFreeBytes });
    await assertDiskReserve(source, minFreeBytes);
  } catch (error) {
    // No installer/build/test command has run. Only this exact private clone
    // attempt may be offered to managed cleanup; never a failed build tree.
    error.dependencyClone = {
      donor: { releases, id: donor.id, digest: donor.digest },
      dependencyRoots: [
        ...new Set(
          Object.keys(entries).map((name) =>
            name.slice(0, name.indexOf("node_modules/") + "node_modules".length),
          ),
        ),
      ],
    };
    throw error;
  }
  return { mode: "reuse", donor: { id: donor.id, digest: donor.digest }, entries };
}
