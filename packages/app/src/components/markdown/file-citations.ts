import { fromMarkdown } from "mdast-util-from-markdown";

export interface FileCitation {
  path: string;
  title: string | null;
}

export type CitationSegment =
  | { kind: "markdown"; text: string; id: string }
  | { kind: "file"; citation: FileCitation; id: string };

function parseCitation(value: string): FileCitation | null {
  const match = /^:codex-file-citation\{([^\r\n]*)\}$/.exec(value);
  if (!match) return null;
  const attributes = parseAttributes(match[1]);
  if (!attributes) return null;
  const path = attributes.get("path");
  if (!path || !safeCitationPath(path)) return null;
  return { path, title: attributes.get("title") ?? null };
}

function parseAttributes(value: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  let rest = value;
  while (rest.trim()) {
    const attribute = /^\s*([a-zA-Z]+)=/.exec(rest);
    if (!attribute || attributes.has(attribute[1])) return null;
    rest = rest.slice(attribute[0].length);
    if (rest[0] !== '"') return null;
    let end = 1;
    for (; end < rest.length; end++) {
      if (rest.charCodeAt(end) === 92) {
        end++;
        continue;
      }
      if (rest[end] === '"') break;
    }
    if (end >= rest.length) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(rest.slice(0, end + 1));
    } catch {
      return null;
    }
    if (typeof decoded !== "string") return null;
    attributes.set(attribute[1], decoded);
    rest = rest.slice(end + 1);
  }
  return attributes;
}

function safeCitationPath(path: string): boolean {
  const controls = [...path].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
  if (controls) return false;
  const windowsAbsolute = /^[a-z]:/i.test(path) && (path[2] === "/" || path.charCodeAt(2) === 92);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(path);
  const webUrl = /^https?:\/\//i.test(path);
  if (hasScheme && !webUrl && !windowsAbsolute) return false;
  if (!webUrl) return true;
  try {
    const url = new URL(path);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Only standalone prose directives become cards; examples and quotations stay literal. */
export function splitFileCitations(source: string): CitationSegment[] {
  if (!source.includes(":codex-file-citation{"))
    return [{ kind: "markdown", text: source, id: "markdown:0" }];
  const segments: CitationSegment[] = [];
  let cursor = 0;
  for (const node of fromMarkdown(source).children) {
    if (node.type !== "paragraph") continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const citation = parseCitation(source.slice(start, end));
    if (!citation) continue;
    if (start > cursor)
      segments.push({
        kind: "markdown",
        text: source.slice(cursor, start),
        id: `markdown:${cursor}`,
      });
    segments.push({ kind: "file", citation, id: `file:${start}` });
    cursor = end;
  }
  if (cursor < source.length)
    segments.push({ kind: "markdown", text: source.slice(cursor), id: `markdown:${cursor}` });
  return segments;
}

export function citationLabel(citation: FileCitation): string {
  if (citation.title) return citation.title;
  if (/^https?:\/\//i.test(citation.path)) {
    const url = new URL(citation.path);
    if (url.hostname === "docs.google.com") {
      if (url.pathname.startsWith("/document/")) return "Google Docs";
      if (url.pathname.startsWith("/spreadsheets/")) return "Google Sheets";
      if (url.pathname.startsWith("/presentation/")) return "Google Slides";
    }
    return url.hostname;
  }
  return citation.path.replaceAll(String.fromCharCode(92), "/").split("/").pop() || citation.path;
}
