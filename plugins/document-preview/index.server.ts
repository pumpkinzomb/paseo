import { z } from "zod";
import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { publishPreview, validateExportUrl } from "./server/publish.js";
import { normalizeSourceUrl, saveDocumentSnapshot } from "./server/snapshot.js";

export const documentPreviewTool = defineAgentTool({
  name: "show_connected_document",
  title: "Show connected document preview",
  description:
    "Show a plain-text snapshot only when the user explicitly wants text. For faithful document pages or workbook tabs use show_rendered_file instead. FIRST read the actual document using the connected Docs/Sheets/Slides tool; pass only its verified title and text here. This tool saves a local plain-text snapshot in the agent workspace; it does NOT fetch the original, synchronize local edits, or prove freshness. After editing the original, read it again and call this tool again to refresh the same preview. Return the exact citation from the result on its own line in your reply. Never put credentials or tokens in the text or URL. For full fidelity Google editing, use the separate original link.",
  input: z.object({
    sourceUrl: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          normalizeSourceUrl(value);
          return true;
        } catch {
          return false;
        }
      }, "Expected a native Google document HTTPS URL"),
    title: z.string().trim().min(1).max(256),
    text: z.string().max(500_000),
    language: z
      .enum(["en", "ko"])
      .default("en")
      .describe("Preview chrome language; match the user language"),
  }),
  async execute(input, { agent, signal }) {
    const snapshot = await saveDocumentSnapshot({
      ...input,
      cwd: agent.cwd,
      capturedAt: new Date().toISOString(),
      signal,
    });
    const citation = `:codex-file-citation{path=${JSON.stringify(snapshot.path)} title=${JSON.stringify(snapshot.title)} purpose="output"}`;
    return {
      text: citation,
      structuredContent: { ...snapshot, citation, kind: "connected-document-snapshot" },
    };
  },
});

export const renderedFilePreviewTool = defineAgentTool({
  name: "show_rendered_file",
  title: "Show original document or workbook preview",
  description:
    "Show an actual PDF/Word/Excel file inside Paseo's existing Files sidebar, not a text reconstruction. For connected Google Docs, export application/pdf using the connected Drive tool first, then pass its user-scoped download URL with format pdf. For Google Sheets, export application/vnd.openxmlformats-officedocument.spreadsheetml.sheet and pass format xlsx to retain sheet tabs and cached cell formatting. Word docx and Excel xlsx render through macOS Quick Look; unsupported hosts fail explicitly. Local source paths must be files within this agent workspace. Export URLs must be actual returned oaiusercontent file references; never invent a URL, use a Google webpage, or pass OAuth credentials. The signed URL is transient and is not saved in the artifact. Cached previews are read-only, not live Google editing; refresh by exporting and calling again. Renderer differences and missing assets are disclosed. Return the exact citation on its own line.",
  input: z.object({
    title: z.string().trim().min(1).max(256),
    sourceUrl: z.string().max(2048).nullable().default(null),
    format: z.enum(["pdf", "docx", "xlsx"]),
    source: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("export"),
        url: z
          .string()
          .max(8192)
          .refine((value) => {
            try {
              validateExportUrl(value);
              return true;
            } catch {
              return false;
            }
          }, "Use the verified provider export file reference"),
      }),
      z.object({ kind: z.literal("workspace-file"), path: z.string().min(1).max(4096) }),
    ]),
  }),
  async execute(input, { agent, signal }) {
    const artifact = await publishPreview({ ...input, cwd: agent.cwd, signal });
    const citation = `:codex-file-citation{path=${JSON.stringify(artifact.path)} title=${JSON.stringify(artifact.title)} purpose="output"}`;
    return {
      text: citation,
      structuredContent: { ...artifact, citation, kind: "rendered-file-preview" },
    };
  },
});

export default function contribute(server: PluginServerContext) {
  return server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose !== "interactive") return;
    return { ...request, tools: [...request.tools, documentPreviewTool, renderedFilePreviewTool] };
  });
}
