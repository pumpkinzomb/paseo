import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deleteClaudeNativeSession } from "./native-session-deletion.js";
import { claudeProjectDir } from "./project-dir.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-claude-native-delete-"));
  const canonical = await import("node:fs/promises").then((fs) => fs.realpath(root));
  roots.push(canonical);
  vi.stubEnv("CLAUDE_CONFIG_DIR", canonical);
  const cwd = path.join(canonical, "project");
  await mkdir(cwd);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const project = await claudeProjectDir(cwd, { configDir: canonical });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, sessionId + ".jsonl"), "{}\n");
  return { root: canonical, handle: { provider: "claude", sessionId, metadata: { cwd } } };
}
it("passes only the exact session and recorded cwd to the SDK", async () => {
  const f = await fixture(),
    remove = vi.fn(async () => {});
  await deleteClaudeNativeSession(f.handle, f.root, remove);
  expect(remove).toHaveBeenCalledExactlyOnceWith(f.handle.sessionId, {
    dir: f.handle.metadata.cwd,
  });
});
it("rejects path-shaped IDs without invoking the SDK", async () => {
  const f = await fixture(),
    remove = vi.fn(async () => {});
  await expect(
    deleteClaudeNativeSession({ ...f.handle, sessionId: "../other" }, f.root, remove),
  ).rejects.toThrow("exact");
  expect(remove).not.toHaveBeenCalled();
});
it("propagates SDK errors rather than pretending deletion succeeded", async () => {
  const f = await fixture();
  await expect(
    deleteClaudeNativeSession(f.handle, f.root, async () => {
      throw Error("SDK failed");
    }),
  ).rejects.toThrow("SDK failed");
});
it("rejects mismatched provider config without changing process environment", async () => {
  const f = await fixture(),
    remove = vi.fn(async () => {});
  vi.stubEnv("CLAUDE_CONFIG_DIR", f.handle.metadata.cwd);
  await expect(deleteClaudeNativeSession(f.handle, f.root, remove)).rejects.toThrow(
    "config differs",
  );
  expect(remove).not.toHaveBeenCalled();
});
it("the official SDK actually removes a fixture transcript and child transcript directory", async () => {
  const f = await fixture();
  const project = await claudeProjectDir(f.handle.metadata.cwd, { configDir: f.root });
  const fs = await import("node:fs/promises");
  const children = path.join(project, f.handle.sessionId, "subagents");
  await fs.mkdir(children, { recursive: true });
  await fs.writeFile(path.join(children, "agent-fixture.jsonl"), "{}\n");
  await deleteClaudeNativeSession(f.handle, f.root);
  await expect(fs.stat(path.join(project, f.handle.sessionId + ".jsonl"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.stat(path.join(project, f.handle.sessionId))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
