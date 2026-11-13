import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
const inflate = promisify(inflateRaw);
const MAX_EXPANDED = 100 * 1024 * 1024;
const MAX_ENTRY = 20 * 1024 * 1024;
export class OfficeArchiveError extends Error {
  constructor(
    public readonly code:
      | "INVALID_OFFICE_ARCHIVE"
      | "OFFICE_LIMIT_EXCEEDED"
      | "ACTIVE_OFFICE_CONTENT",
  ) {
    super(code);
    this.name = "OfficeArchiveError";
  }
}
interface OfficeZipEntry {
  name: string;
  size: number;
  method: number;
  start: number;
  compressed: number;
  next: number;
}
function xmlEntities(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi, (match, entity: string) => {
    const code =
      entity[0].toLowerCase() === "x"
        ? Number.parseInt(entity.slice(1), 16)
        : Number.parseInt(entity, 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
function checkXml(bytes: Buffer, downloadOnly: boolean): void {
  const little = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0);
  const big = (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c);
  let encoding = "utf-8";
  if (little) encoding = "utf-16le";
  if (big) encoding = "utf-16be";
  let xml;
  try {
    xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  }
  if (
    xml.includes(String.fromCharCode(0)) ||
    /<!\s*(DOCTYPE|ENTITY)/i.test(xml) ||
    (!downloadOnly && /TargetMode\s*=\s*["']\s*External\s*["']/i.test(xmlEntities(xml)))
  )
    throw new OfficeArchiveError("ACTIVE_OFFICE_CONTENT");
}
function centralEntry(
  bytes: Buffer,
  cursor: number,
  centralStart: number,
  centralEnd: number,
  downloadOnly: boolean,
): OfficeZipEntry {
  if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50)
    throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  const flags = bytes.readUInt16LE(cursor + 8),
    method = bytes.readUInt16LE(cursor + 10),
    compressed = bytes.readUInt32LE(cursor + 20),
    size = bytes.readUInt32LE(cursor + 24);
  const nameSize = bytes.readUInt16LE(cursor + 28),
    next =
      cursor + 46 + nameSize + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  const mode = bytes.readUInt32LE(cursor + 38) >>> 16,
    local = bytes.readUInt32LE(cursor + 42);
  if (next > centralEnd || flags & 1 || ![0, 8].includes(method) || (mode & 0o170000) === 0o120000)
    throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8");
  const segments = name.replaceAll(String.fromCharCode(92), "/").split("/");
  if (
    !name ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    segments.includes("..") ||
    name.includes(String.fromCharCode(0))
  )
    throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  if (!downloadOnly && /vbaproject|activex|embeddings\//i.test(name))
    throw new OfficeArchiveError("ACTIVE_OFFICE_CONTENT");
  if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
    throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  if (start + compressed > centralStart) throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  return { name, size, method, start, compressed, next };
}
async function checkEntry(
  bytes: Buffer,
  entry: OfficeZipEntry,
  downloadOnly: boolean,
): Promise<void> {
  let content: Buffer;
  try {
    content =
      entry.method === 0
        ? bytes.subarray(entry.start, entry.start + entry.compressed)
        : await inflate(bytes.subarray(entry.start, entry.start + entry.compressed), {
            maxOutputLength: MAX_ENTRY,
          });
  } catch {
    throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  }
  if (content.length !== entry.size) throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  if (/\.(xml|rels)$/i.test(entry.name)) checkXml(content, downloadOnly);
}
/** Bound decompression and reject active/external Office relationships before invoking an OS renderer. */
export async function validateOfficeArchive(
  bytes: Buffer,
  kind: "docx" | "xlsx" | "pptx",
  options: { purpose?: "render" | "download" } = {},
): Promise<void> {
  const downloadOnly = options.purpose === "download";
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--)
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
    throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
  const count = bytes.readUInt16LE(end + 10),
    centralStart = bytes.readUInt32LE(end + 16),
    centralEnd = centralStart + bytes.readUInt32LE(end + 12);
  if (!count || count > 2000 || centralEnd > end || count !== bytes.readUInt16LE(end + 8))
    throw new OfficeArchiveError("OFFICE_LIMIT_EXCEEDED");
  const names = new Set<string>();
  let expanded = 0,
    cursor = centralStart;
  for (let index = 0; index < count; index++) {
    const entry = centralEntry(bytes, cursor, centralStart, centralEnd, downloadOnly);
    if (names.has(entry.name)) throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
    names.add(entry.name);
    expanded += entry.size;
    if (entry.size > MAX_ENTRY || expanded > MAX_EXPANDED)
      throw new OfficeArchiveError("OFFICE_LIMIT_EXCEEDED");
    await checkEntry(bytes, entry, downloadOnly);
    cursor = entry.next;
  }
  const parts = {
    docx: "word/document.xml",
    xlsx: "xl/workbook.xml",
    pptx: "ppt/presentation.xml",
  };
  const required = parts[kind];
  if (!names.has("[Content_Types].xml") || !names.has(required))
    throw new OfficeArchiveError("INVALID_OFFICE_ARCHIVE");
}
