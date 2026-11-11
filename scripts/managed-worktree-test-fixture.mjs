import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerManagedDependencies } from "./managed-worktree-maintenance.mjs";
import { dependencyInputs } from "./dev-update-dependencies.mjs";
import { hash, atomicJson, scanRelease, manifestDigest } from "./dev-update-store.mjs";
export async function managedDependencyFixture(t, { fileCount = 1, nested = false } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "retirement-fixture-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source"),
    root = path.join(base, "child"),
    control = path.join(base, "control"),
    releases = path.join(base, "releases"),
    donorRoot = path.join(releases, "donor"),
    registry = path.join(control, "managed-worktrees");
  for (const dir of [source, control, donorRoot]) await fs.mkdir(dir, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, { cwd: source, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(source, "package.json"), '{"name":"fixture"}');
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules\nhistory\n");
  await fs.writeFile(path.join(source, "package-lock.json"), "{}");
  git("add", ".");
  git("commit", "-qm", "base");
  const revision = git("rev-parse", "HEAD");
  git("worktree", "add", "-q", "--detach", root);
  await fs.copyFile(path.join(source, "package.json"), path.join(donorRoot, "package.json"));
  await fs.copyFile(
    path.join(source, "package-lock.json"),
    path.join(donorRoot, "package-lock.json"),
  );
  for (const dir of [root, donorRoot]) {
    await fs.mkdir(path.join(dir, "node_modules"));
    await fs.writeFile(path.join(dir, "node_modules", "payload"), "dependency");
    for (let i = 1; i < fileCount; i++)
      await fs.writeFile(path.join(dir, "node_modules", `payload-${i}`), "dependency");
    if (nested) {
      await fs.mkdir(path.join(dir, "packages/pkg/node_modules"), { recursive: true });
      await fs.writeFile(path.join(dir, "packages/pkg/node_modules/payload"), "dependency");
    }
  }
  await fs.writeFile(path.join(root, "history"), "conversation");
  const manifest = {
    schemaVersion: 1,
    id: "donor",
    sourceRevision: revision,
    stateCompatibility: "preserve",
    entries: await scanRelease(donorRoot),
  };
  await atomicJson(path.join(donorRoot, "release.json"), manifest);
  const digest = manifestDigest(manifest);
  const donor = { id: "donor", digest },
    entries = Object.fromEntries(
      Object.entries(manifest.entries).filter(([name]) => name.includes("node_modules/")),
    );
  const receipt = { schemaVersion: 1, root, donor, inputs: await dependencyInputs(root), entries };
  await atomicJson(path.join(root, ".managed-dependencies.json"), receipt);
  const context = {
    sourceRoot: source,
    releases,
    donor,
    protectedRoots: [control, releases],
    maintenanceRegistry: registry,
  };
  await registerManagedDependencies(context, root, receipt);
  await atomicJson(path.join(control, "config.json"), { releases });
  await atomicJson(path.join(control, "state.json"), { current: donor });
  return {
    base,
    root,
    registry,
    context,
    receipt,
    evidence: { sourceRevision: revision, releaseDigest: digest },
    id: hash(root),
  };
}
