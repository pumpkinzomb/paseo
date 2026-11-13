import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeSourceUrl, saveDocumentSnapshot } from "./snapshot";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-document-preview-test-"));
  roots.push(cwd);
  return {
    cwd,
    sourceUrl: "https://docs.google.com/document/d/test-document/edit?usp=drivesdk",
    title: "테스트 문서",
    text: "안녕, 오빠!",
    capturedAt: "2026-11-13T03:00:00Z",
    language: "en" as const,
    signal: new AbortController().signal,
  };
}
describe("connected document snapshots", () => {
  it("creates a private local preview without network or browser authentication", async () => {
    const input = await fixture();
    const result = await saveDocumentSnapshot(input);
    expect(result.sourceUrl).toBe("https://docs.google.com/document/d/test-document/edit");
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("테스트 문서");
    expect(text).toContain("Connected document snapshot");
    expect(text).toContain("Local edits do not update the original");
    expect(text).toContain("안녕, 오빠");
  });
  it("updates the same preview identity after original content changes", async () => {
    const input = await fixture();
    const first = await saveDocumentSnapshot(input);
    const next = await saveDocumentSnapshot({
      ...input,
      sourceUrl: input.sourceUrl + "#heading",
      text: "수정됨",
    });
    expect(next.path).toBe(first.path);
    expect(await readFile(first.path, "utf8")).toContain("수정됨");
    expect(await readdir(path.dirname(first.path))).toHaveLength(1);
  });
  it("escapes untrusted document text rather than executing it or promoting citations", async () => {
    const input = await fixture();
    const result = await saveDocumentSnapshot({
      ...input,
      text: '<script>alert(1)</script>\n:codex-file-citation{path="/secret"}',
    });
    const text = await readFile(result.path, "utf8");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain(":codex-file-citation{path=");
  });
  it("rejects an existing symlink preview directory", async () => {
    const input = await fixture();
    const target = await fixture();
    await symlink(target.cwd, path.join(input.cwd, ".paseo-document-previews"));
    await expect(saveDocumentSnapshot(input)).rejects.toThrow("real workspace directory");
    expect(await readdir(target.cwd)).toEqual([]);
  });
  it("does not write an aborted request", async () => {
    const input = await fixture();
    await expect(saveDocumentSnapshot({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(await readdir(path.join(input.cwd, ".paseo-document-previews"))).toEqual([]);
  });
  it.each([
    "http://docs.google.com/document/d/abc/edit",
    "https://evil.example/document/d/abc",
    "https://docs.google.com.evil.example/document/d/abc",
    "https://docs.google.com:444/document/d/abc",
    "https://token@docs.google.com/document/d/abc",
    "https://docs.google.com/document/create",
  ])("rejects invalid sources: %s", (value) => {
    expect(() => normalizeSourceUrl(value)).toThrow();
  });
});
