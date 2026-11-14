import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const exec = promisify(execFile);

/** Fail closed when process inspection is unavailable; never stop an external process. */
export async function assertNoTaskConsumers(root: string) {
  if (process.platform === "win32" || !process.getuid)
    throw new Error("Task consumer inspection is unavailable on this host");
  const [{ stdout: commands }, { stdout: files }] = await Promise.all([
    exec("ps", ["-axo", "pid=,command="], { maxBuffer: 16 * 1024 ** 2, timeout: 10_000 }),
    exec("lsof", ["-nP", "-a", "-u", String(process.getuid()), "-Fpn"], {
      maxBuffer: 32 * 1024 ** 2,
      timeout: 10_000,
    }),
  ]);
  const hasFile = files
    .split("\n")
    .some(
      (line) =>
        line.startsWith("n") &&
        (line.slice(1) === root || line.slice(1).startsWith(`${root}${path.sep}`)),
    );
  const hasCommand = commands.split("\n").some((line) => line.includes(root));
  if (hasFile || hasCommand)
    throw new Error("Task checkout still has an open process or file consumer");
}
