import { z } from "zod";
import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { normalizeSourceUrl, saveDocumentSnapshot } from "./server/snapshot.js";

export const documentPreviewTool = defineAgentTool({
  name: "show_connected_document",
  title: "Show connected document preview",
  description:
    "Show a Google document in a file card and Paseo's side pane without a browser login. FIRST read the actual document using the connected Docs/Sheets/Slides tool; pass only its verified title and text here. This tool saves a local plain-text snapshot in the agent workspace; it does NOT fetch the original, synchronize local edits, or prove freshness. After editing the original, read it again and call this tool again to refresh the same preview. Return the exact citation from the result on its own line in your reply. Never put credentials or tokens in the text or URL. For full fidelity Google editing, use the separate original link.",
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

export default function contribute(server: PluginServerContext) {
  return server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose !== "interactive") return;
    return { ...request, tools: [...request.tools, documentPreviewTool] };
  });
}
