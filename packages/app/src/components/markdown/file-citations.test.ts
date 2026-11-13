import { describe, expect, it } from "vitest";
import { citationLabel, splitFileCitations as splitWithIds } from "./file-citations";

function splitFileCitations(source: string) {
  return splitWithIds(source).map(({ id: _id, ...segment }) => segment);
}

const directive =
  ':codex-file-citation{path="/workspace/문서.md" title="테스트 문서" purpose="output"}';
describe("file citation cards", () => {
  it("keeps prose and card order", () => {
    expect(splitFileCitations(`Before\n\n${directive}\n\nAfter`)).toEqual([
      { kind: "markdown", text: "Before\n\n" },
      { kind: "file", citation: { path: "/workspace/문서.md", title: "테스트 문서" } },
      { kind: "markdown", text: "\n\nAfter" },
    ]);
  });
  it.each([
    `\`\`\`text\n${directive}\n\`\`\``,
    `> ${directive}`,
    `\`${directive}\``,
    `Example: ${directive}`,
    ':codex-file-citation{path="javascript:alert(1)"}',
    ':codex-file-citation{path="data:text/html,secret"}',
    ':codex-file-citation{path="https://"}',
    ':codex-file-citation{path="/a.md" path="/b.md"}',
    ':codex-file-citation{path="/a.md"',
  ])("preserves code, quoted, invalid or incomplete directives: %s", (source) => {
    expect(splitFileCitations(source)).toEqual([{ kind: "markdown", text: source }]);
  });
  it("does not alter ordinary Markdown", () => {
    const source = "# Heading\n\n[Link](https://example.com)";
    expect(splitFileCitations(source)).toEqual([{ kind: "markdown", text: source }]);
  });
  it("uses a useful label without exposing the raw directive", () => {
    expect(
      citationLabel({ path: "https://docs.google.com/document/d/abc/edit", title: null }),
    ).toBe("Google Docs");
    expect(citationLabel({ path: "/work/문서.md", title: null })).toBe("문서.md");
    expect(citationLabel({ path: "/work/abc.md", title: "내 문서" })).toBe("내 문서");
  });
  it("decodes JSON-escaped titles and file paths", () => {
    const citation = { path: "C:\\work\\문서.md", title: 'A "title"' };
    expect(
      splitFileCitations(
        `:codex-file-citation{path=${JSON.stringify(citation.path)} title=${JSON.stringify(citation.title)}}`,
      ),
    ).toEqual([{ kind: "file", citation }]);
  });
});
