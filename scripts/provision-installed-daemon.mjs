import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

async function privateDirectory(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || (await fs.realpath(root)) !== root)
    throw new Error("Expected canonical non-aliased directory");
  const s = await fs.lstat(root);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700)
    throw new Error("Directory must be user-owned mode 0700");
}
function validateEndpoint(listen) {
  const url = new URL(`http://${listen}`);
  if (
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.host !== listen ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Expected exact loopback daemon endpoint");
}
function makeRecord(home, version, instance, status) {
  if (
    !instance ||
    instance.uid !== process.getuid() ||
    !Number.isSafeInteger(instance.pid) ||
    instance.pid <= 0 ||
    typeof instance.startedAt !== "string" ||
    !instance.startedAt ||
    typeof instance.serverId !== "string" ||
    !instance.serverId ||
    typeof instance.listen !== "string"
  )
    throw new Error("Invalid live daemon identity");
  validateEndpoint(instance.listen);
  if (
    status.localDaemon !== "running" ||
    status.pid !== instance.pid ||
    status.startedAt !== instance.startedAt ||
    status.serverId !== instance.serverId ||
    status.listen !== instance.listen ||
    status.daemonVersion !== version
  )
    throw new Error("Daemon status/version does not match live identity");
  return {
    schemaVersion: 1,
    approved: true,
    home,
    serverId: instance.serverId,
    pid: instance.pid,
    startedAt: instance.startedAt,
    listen: instance.listen,
    version,
  };
}
async function existingRecord(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = await handle.stat();
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o600 ||
      s.nlink !== 1 ||
      s.size > 8192
    )
      throw new Error("Existing registration is not a private regular file");
    return await handle.readFile("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
/** Inspector is injected only for fixtures; executable CLI constructs its own fixed inspector. */
export async function provisionInstalledDaemon(
  { home, userHome, version, approve = false, replace = false },
  inspect,
) {
  await privateDirectory(home);
  const root = path.join(userHome, ".paseo-installed"),
    file = path.join(root, "daemon.json");
  const initial = await inspect(home);
  const record = makeRecord(home, version, initial.instance, initial.status);
  if (!approve) return { state: "dry-run", record, writes: false };
  await fs.mkdir(root, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await privateDirectory(root);
  const lock = path.join(root, "provision.lock");
  await fs.mkdir(lock, { mode: 0o700 });
  const temporary = path.join(root, `.daemon-${crypto.randomUUID()}.tmp`);
  try {
    const prior = await existingRecord(file);
    if (prior !== null && !replace)
      throw new Error("Existing registration requires explicit --replace");
    const current = await inspect(home);
    if (
      JSON.stringify(makeRecord(home, version, current.instance, current.status)) !==
      JSON.stringify(record)
    )
      throw new Error("Daemon changed before provisioning");
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (prior === null) {
      await fs.link(temporary, file);
      await fs.unlink(temporary);
    } else {
      if ((await existingRecord(file)) !== prior)
        throw new Error("Registration changed before replacement");
      await fs.rename(temporary, file);
    }
    const directory = await fs.open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { state: "provisioned", record, writes: true };
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rmdir(lock);
  }
}
async function main(args) {
  const flags = new Set(args.filter((value) => value.startsWith("--")));
  if (
    [...flags].some((flag) => !["--home", "--approve", "--replace"].includes(flag)) ||
    args.filter((x) => x === "--home").length !== 1
  )
    throw new Error("Usage: --home CANONICAL_HOME [--approve] [--replace]");
  const home = args[args.indexOf("--home") + 1];
  if (
    !home ||
    home.startsWith("--") ||
    args.length !== 2 + Number(flags.has("--approve")) + Number(flags.has("--replace"))
  )
    throw new Error("Invalid arguments");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if ((await fs.realpath(repo)) !== repo) throw new Error("Repository path is aliased");
  const cli = path.join(repo, "packages/cli/dist/index.js");
  const daemonModule = path.join(repo, "packages/server/dist/server/server/daemon-instance.js");
  for (const file of [cli, daemonModule])
    if ((await fs.realpath(file)) !== file) throw new Error("Built tool path is aliased");
  const { readDaemonInstance } = await import(pathToFileURL(daemonModule).href);
  const { version } = JSON.parse(
    await fs.readFile(path.join(repo, "packages/desktop/package.json"), "utf8"),
  );
  const result = await provisionInstalledDaemon(
    {
      home,
      userHome: os.homedir(),
      version,
      approve: flags.has("--approve"),
      replace: flags.has("--replace"),
    },
    async (directory) => {
      const instance = await readDaemonInstance(directory);
      const { stdout } = await exec(
        process.execPath,
        [cli, "daemon", "status", "--home", directory, "--json"],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      return { instance, status: JSON.parse(stdout) };
    },
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Provisioning failed; no daemon ownership was adopted. Check build, private paths, identity and explicit approval.\n",
    );
    process.exitCode = 1;
  });
}
