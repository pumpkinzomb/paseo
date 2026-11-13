import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DocumentSnapshotInput {
  cwd: string;
  sourceUrl: string;
  title: string;
  text: string;
  capturedAt: string;
  language: "en" | "ko";
  signal: AbortSignal;
}

export function normalizeSourceUrl(value: string): string {
  const url = new URL(value);
  const googleDocument = /^\/(document|spreadsheets|presentation)\/d\/[a-zA-Z0-9_-]+(?:\/|$)/.test(
    url.pathname,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    url.port ||
    url.username ||
    url.password ||
    !googleDocument
  ) {
    throw new Error("Document preview requires a native Google Docs, Sheets or Slides HTTPS URL");
  }
  url.search = "";
  url.hash = "";
  const match = /^\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/.exec(url.pathname);
  if (!match) throw new Error("Invalid Google document URL");
  url.pathname = `/${match[1]}/d/${match[2]}/edit`;
  return url.toString();
}

function escapeMarkdown(value: string): string {
  const backslash = String.fromCharCode(92);
  const punctuation = new Set((backslash + "`*_{}[]()<>#+.!|~-").split(""));
  return [...value]
    .map((character) => (punctuation.has(character) ? backslash + character : character))
    .join("");
}

/** This is a readable local snapshot, not a second OAuth session or a live Google editor. */
export async function saveDocumentSnapshot(input: DocumentSnapshotInput) {
  const sourceUrl = normalizeSourceUrl(input.sourceUrl);
  const root = await realpath(input.cwd);
  const directory = path.join(root, ".paseo-document-previews");
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(directory)) !== directory) {
    throw new Error("Document preview directory must be a real workspace directory");
  }
  const key = createHash("sha256").update(sourceUrl).digest("hex");
  const file = path.join(directory, `${key}.md`);
  const temporary = path.join(directory, `${key}.${randomUUID()}.tmp`);
  const labels =
    input.language === "ko"
      ? {
          original: "구글 원본 열기",
          snapshot: "연결 문서 미리보기",
          notice:
            "원본을 읽어 저장한 미리보기야. 여기서 로컬 파일을 수정해도 구글 원본에는 반영되지 않아. 원본 수정과 미리보기 갱신은 도우미에게 요청해줘.",
        }
      : {
          original: "Open Google original",
          snapshot: "Connected document snapshot",
          notice:
            "Local edits do not update the original. Ask the assistant to modify the connected document and refresh this preview.",
        };
  const marker = "<!-- paseo-connected-document-snapshot -->";
  const markdown = `${marker}\n# ${escapeMarkdown(input.title)}\n\n[${labels.original}](${sourceUrl})\n\n> ${labels.snapshot} · ${input.capturedAt}\n> ${labels.notice}\n\n${escapeMarkdown(input.text)}\n`;
  input.signal.throwIfAborted();
  try {
    await writeFile(temporary, markdown, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: file, title: input.title, sourceUrl, capturedAt: input.capturedAt };
}
