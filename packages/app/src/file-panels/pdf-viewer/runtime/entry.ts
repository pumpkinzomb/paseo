import { createPdfViewer } from "./viewer";
import { parsePdfPreferences, type PdfViewerLabels } from "../model";
const root = document.getElementById("pdf-root");
if (!root) throw new Error("Missing PDF root");
const viewer = createPdfViewer(root, { send: (message) => parent.postMessage(message, "*") });
const labelKeys = [
  "loading",
  "failed",
  "toggle",
  "resize",
  "previous",
  "next",
  "page",
  "zoomOut",
  "zoomIn",
  "fitWidth",
  "openOriginal",
  "password",
] as const;
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent || typeof event.data !== "object" || event.data === null) return;
  const data = event.data as Record<string, unknown>;
  if (data.type === "pdf-reset") {
    viewer.reset();
    return;
  }
  if (
    data.type !== "pdf-load" ||
    !(data.bytes instanceof ArrayBuffer) ||
    data.bytes.byteLength > 100 * 1024 * 1024 ||
    typeof data.dark !== "boolean"
  )
    return;
  const preferences = parsePdfPreferences(data.preferences);
  if (!preferences || typeof data.labels !== "object" || data.labels === null) return;
  const labels = data.labels as Record<string, unknown>;
  if (!labelKeys.every((key) => typeof labels[key] === "string" && labels[key].length <= 1024))
    return;
  void viewer
    .load(data.bytes, preferences, labels as unknown as PdfViewerLabels, data.dark)
    .catch(() => parent.postMessage({ type: "pdf-error" }, "*"));
});
window.addEventListener("pagehide", () => viewer.destroy(), { once: true });
parent.postMessage({ type: "pdf-ready" }, "*");
