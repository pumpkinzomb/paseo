import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSelfDevelopmentPolicy,
  assertSelfDevelopmentCwd,
  selfDevelopmentPrompt,
} from "./self-development-policy.js";
const roots: string[] = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paseo-policy-"));
  roots.push(root);
  const labRoot = join(root, "lab"),
    live = join(root, "live");
  mkdirSync(labRoot);
  mkdirSync(live);
  const policy = (await readSelfDevelopmentPolicy(
    JSON.stringify({ labRoot, protectedRoots: [live] }),
  ))!;
  return { root, labRoot, live, policy };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe("self-development workflow policy", () => {
  it("is opt-in and leaves other installations unchanged", async () => {
    expect(await readSelfDevelopmentPolicy(undefined)).toBeUndefined();
    expect(selfDevelopmentPrompt(undefined)).toBe("");
    await expect(assertSelfDevelopmentCwd(undefined, "/anything")).resolves.toBeUndefined();
  });
  it("allows lab and unrelated projects, rejects protected descendants", async () => {
    const { root, labRoot, live, policy } = await fixture();
    await expect(assertSelfDevelopmentCwd(policy, labRoot)).resolves.toBeUndefined();
    await expect(assertSelfDevelopmentCwd(policy, join(root, "other"))).resolves.toBeUndefined();
    await expect(assertSelfDevelopmentCwd(policy, live + "-other")).resolves.toBeUndefined();
    await expect(assertSelfDevelopmentCwd(policy, join(live, "new", "nested"))).rejects.toThrow(
      "protected",
    );
  });
  it("resolves symlinks before checking including nonexistent descendants", async () => {
    const { root, live, policy } = await fixture();
    const alias = join(root, "alias");
    symlinkSync(live, alias);
    await expect(assertSelfDevelopmentCwd(policy, join(alias, "future"))).rejects.toThrow(
      "protected",
    );
  });
  it("rejects malformed and overlapping configurations", async () => {
    const { labRoot } = await fixture();
    await expect(readSelfDevelopmentPolicy("{}")).rejects.toThrow();
    await expect(
      readSelfDevelopmentPolicy(JSON.stringify({ labRoot, protectedRoots: [labRoot] })),
    ).rejects.toThrow("overlaps");
  });
  it("instructs all providers about delegation, approval and limitations", async () => {
    const { policy, labRoot } = await fixture();
    const prompt = selfDevelopmentPrompt(policy);
    expect(prompt).toContain(labRoot);
    expect(prompt).toContain("delegated agents");
    expect(prompt).toContain("not an OS sandbox");
    expect(prompt).toContain("explicit approval");
    expect(prompt).toContain("Other user projects remain allowed");
  });
});
