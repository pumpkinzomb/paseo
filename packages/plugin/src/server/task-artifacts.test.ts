import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  symlink,
  link,
  mkdir,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  prepareTaskArtifactDirectory,
  inspectTaskArtifacts,
  removeTaskArtifacts,
} from "./task-artifacts.js";
const roots: string[] = [];
async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-task-output-")));
  roots.push(cwd);
  return { cwd, workspaceId: "first" };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("separates workspace ownership even when their cwd is shared and removes only the selected scope", async () => {
  const a = await fixture(),
    b = { ...a, workspaceId: "second" };
  const first = await prepareTaskArtifactDirectory(a),
    second = await prepareTaskArtifactDirectory(b);
  expect(first).not.toBe(second);
  expect(await prepareTaskArtifactDirectory(a)).toBe(first);
  await writeFile(path.join(first, "patch.diff"), "a");
  await writeFile(path.join(second, "report.md"), "b");
  await mkdir(path.join(a.cwd, "artifacts"));
  await writeFile(path.join(a.cwd, "artifacts", "legacy.patch"), "legacy");
  for (const name of ["source.ts", "auth.json", "Paseo.app"])
    await writeFile(path.join(a.cwd, name), "protected");
  await removeTaskArtifacts(a);
  expect(await inspectTaskArtifacts(a)).toBeNull();
  expect(await readFile(path.join(second, "report.md"), "utf8")).toBe("b");
  expect(await readFile(path.join(a.cwd, "artifacts", "legacy.patch"), "utf8")).toBe("legacy");
  for (const name of ["source.ts", "auth.json", "Paseo.app"])
    expect(await readFile(path.join(a.cwd, name), "utf8")).toBe("protected");
});
it("never adopts or removes an unmarked or changed owner directory", async () => {
  const owner = await fixture(),
    d = await prepareTaskArtifactDirectory(owner);
  await writeFile(
    path.join(d, ".paseo-owner.json"),
    JSON.stringify({ version: 1, workspaceId: "another", root: owner.cwd }),
  );
  await expect(removeTaskArtifacts(owner)).rejects.toThrow("ownership");
  await rm(path.join(d, ".paseo-owner.json"));
  await expect(prepareTaskArtifactDirectory(owner)).rejects.toThrow();
  expect(await readdir(d)).toEqual([]);
});
it("refuses a symlinked shared parent without touching its target", async () => {
  const owner = await fixture(),
    target = await fixture();
  await symlink(target.cwd, path.join(owner.cwd, ".paseo-task-artifacts"));
  await expect(prepareTaskArtifactDirectory(owner)).rejects.toThrow("redirect");
  await expect(removeTaskArtifacts(owner)).rejects.toThrow("redirect");
  expect(await readdir(target.cwd)).toEqual([]);
});
it.each(["symlink", "hardlink"])(
  "rejects a %s inside owned output and preserves all files",
  async (kind) => {
    const owner = await fixture(),
      d = await prepareTaskArtifactDirectory(owner),
      source = path.join(owner.cwd, "source.ts");
    await writeFile(source, "keep");
    if (kind === "symlink") await symlink(source, path.join(d, "unsafe"));
    else await link(source, path.join(d, "unsafe"));
    await expect(removeTaskArtifacts(owner)).rejects.toThrow("linked");
    expect(await readFile(source, "utf8")).toBe("keep");
    expect(await readFile(path.join(d, ".paseo-owner.json"), "utf8")).toContain(owner.workspaceId);
  },
);
it("inspection of absent output never creates directories, and missing old workspaces do not block removal", async () => {
  const owner = await fixture();
  expect(await inspectTaskArtifacts(owner)).toBeNull();
  expect(await readdir(owner.cwd)).toEqual([]);
  await removeTaskArtifacts({ ...owner, cwd: path.join(owner.cwd, "missing") });
  expect(await readdir(owner.cwd)).toEqual([]);
});
