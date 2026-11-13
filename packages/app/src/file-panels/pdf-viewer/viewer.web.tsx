import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_PDF_PREFERENCES,
  parsePdfPreferences,
  type PdfViewerLabels,
  type PdfViewerLoadMessage,
} from "./model";
import { pdfRuntimeHtml } from "./runtime/html.gen";
const preferenceKey = "paseo.pdf-viewer.preferences.v1";
function readPreferences() {
  try {
    return (
      parsePdfPreferences(JSON.parse(localStorage.getItem(preferenceKey) ?? "null")) ?? {
        ...DEFAULT_PDF_PREFERENCES,
      }
    );
  } catch {
    return { ...DEFAULT_PDF_PREFERENCES };
  }
}
const containerStyle = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  height: "100%",
  width: "100%",
} as const;
const frameStyle = { border: 0, flex: 1, minHeight: 0, width: "100%", height: "100%" } as const;
interface PdfViewerProps {
  url: string;
  testID?: string;
  colorScheme?: "light" | "dark";
}
function PdfViewerImpl({ url, testID, colorScheme = "dark" }: PdfViewerProps) {
  const { t } = useTranslation();
  const dark = colorScheme === "dark";
  const labels = useMemo<PdfViewerLabels>(
    () => ({
      loading: t("pdfViewer.loading"),
      failed: t("pdfViewer.failed"),
      toggle: t("pdfViewer.toggle"),
      resize: t("pdfViewer.resize"),
      previous: t("pdfViewer.previous"),
      next: t("pdfViewer.next"),
      page: t("pdfViewer.page"),
      zoomOut: t("pdfViewer.zoomOut"),
      zoomIn: t("pdfViewer.zoomIn"),
      fitWidth: t("pdfViewer.fitWidth"),
      openOriginal: t("pdfViewer.openOriginal"),
      password: t("pdfViewer.password"),
    }),
    [t],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const sendRef = useRef<() => void>(() => {});
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const frameReady = useCallback(() => {
    ready.current = true;
    sendRef.current();
  }, []);
  const openOriginal = useCallback(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);
  useEffect(() => {
    const lifetime = new AbortController();
    let sent = false;
    async function send() {
      if (sent || !ready.current || !url.startsWith("blob:")) return;
      sent = true;
      frame.current?.contentWindow?.postMessage({ type: "pdf-reset" }, "*");
      try {
        const response = await fetch(url, { signal: lifetime.signal });
        if (
          !response.ok ||
          response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
            "application/pdf"
        )
          throw Error("Not a PDF");
        if (Number(response.headers.get("content-length")) > 100 * 1024 * 1024)
          throw Error("PDF too large");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 100 * 1024 * 1024) throw Error("PDF too large");
        if (lifetime.signal.aborted) return;
        const message: PdfViewerLoadMessage = {
          type: "pdf-load",
          bytes,
          preferences: readPreferences(),
          labels,
          dark,
        };
        frame.current?.contentWindow?.postMessage(message, "*", [bytes]);
      } catch {
        if (!lifetime.signal.aborted) setFailedUrl(url);
      }
    }
    sendRef.current = () => {
      void send();
    };
    function receive(event: MessageEvent<unknown>) {
      if (
        event.source !== frame.current?.contentWindow ||
        typeof event.data !== "object" ||
        event.data === null
      )
        return;
      const data = event.data as Record<string, unknown>;
      if (data.type === "pdf-ready") {
        ready.current = true;
        void send();
      } else if (data.type === "pdf-error") setFailedUrl(url);
      else if (data.type === "pdf-loaded") setFailedUrl(null);
      else if (data.type === "pdf-preferences") {
        const preferences = parsePdfPreferences(data.preferences);
        if (preferences)
          try {
            localStorage.setItem(preferenceKey, JSON.stringify(preferences));
          } catch {
            /* Preview still works when storage is unavailable. */
          }
      }
    }
    window.addEventListener("message", receive);
    if (ready.current) void send();
    return () => {
      lifetime.abort();
      window.removeEventListener("message", receive);
      sendRef.current = () => {};
    };
  }, [url, labels, dark]);
  return (
    <div style={containerStyle}>
      {failedUrl === url ? (
        <div role="alert">
          {labels.failed}{" "}
          <button type="button" onClick={openOriginal}>
            {labels.openOriginal}
          </button>
        </div>
      ) : null}
      <iframe
        ref={frame}
        title={t("pdfViewer.title")}
        data-testid={testID}
        sandbox="allow-scripts"
        srcDoc={pdfRuntimeHtml}
        onLoad={frameReady}
        referrerPolicy="no-referrer"
        style={frameStyle}
      />
    </div>
  );
}

const ThemedPdfViewer = withUnistyles(PdfViewerImpl);
const mapTheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });
export function PdfViewer(props: Omit<PdfViewerProps, "colorScheme">) {
  return <ThemedPdfViewer {...props} uniProps={mapTheme} />;
}
