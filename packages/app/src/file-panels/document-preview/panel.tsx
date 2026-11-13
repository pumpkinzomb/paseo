import { isWeb } from "@/constants/platform";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { useFileText, useFileUrl, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { DOCUMENT_PREVIEW_MAX_BYTES, type DocumentPreviewArtifact } from "@getpaseo/plugin";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ExternalLink, Printer } from "lucide-react-native";
import { PdfPrintActionContext, type PdfPrintAction } from "../pdf-viewer/actions";
import { OriginalDownload } from "./original-download";
import {
  PaneContentToolbar,
  ToolbarButton,
  ToolbarControls,
} from "@/components/ui/pane-content-toolbar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useFileHandle, useFileHandleSnapshot } from "../file";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { FilePanelLoading } from "../loading";
import { DocumentFrame } from "../document-frame";
import { openExternalUrl } from "@/utils/open-external-url";
import { parseDocumentPreview, previewPdfPath } from "./model";
import { OfficeFrame } from "./office-frame";
const OpenOriginalIcon = withUnistyles(ExternalLink, mutedIconColorMapping);
const PrintIcon = withUnistyles(Printer, mutedIconColorMapping);
const tabStateSchema = z.record(z.string(), z.json());

export function PdfFilePanel({ file }: Pick<PluginFilePanelProps, "file">) {
  const url = useFileUrl(file);
  if (url.status === "loading") return <FilePanelLoading />;
  if (url.status === "error") return <PreviewError />;
  return <DocumentFrame url={url.url} testID="original-pdf-viewer" downloadName={file.name} />;
}
function PreviewError() {
  const { t } = useTranslation();
  return (
    <View style={styles.center}>
      <Text style={styles.error} accessibilityRole="alert">
        {t("documentPreview.invalidSnapshot")}
      </Text>
    </View>
  );
}
export function DocumentPreviewPanel(props: PluginFilePanelProps) {
  if (props.file.size > DOCUMENT_PREVIEW_MAX_BYTES) return <PreviewError />;
  return <ReadDocumentPreview {...props} />;
}
function ReadDocumentPreview({ file, tab, host, workspaceId }: PluginFilePanelProps) {
  const state = useFileText(file);
  const text = state.status === "ready" ? state.text : null;
  const artifact = useMemo(() => (text === null ? null : parseDocumentPreview(text)), [text]);
  const pdf = useMemo(
    () =>
      artifact?.content.kind === "pdf" ? (
        <RenderedPdfAsset
          manifestPath={file.path}
          asset={artifact.content.asset}
          serverId={host.id}
          workspaceId={workspaceId}
        />
      ) : null,
    [artifact?.content, file.path, host.id, workspaceId],
  );
  const download = useMemo(
    () =>
      artifact ? (
        <OriginalDownload
          artifact={artifact}
          manifestPath={file.path}
          serverId={host.id}
          workspaceId={workspaceId}
        />
      ) : null,
    [artifact, file.path, host.id, workspaceId],
  );
  useEffect(() => {
    if (!artifact) return;
    const previous = tabStateSchema.safeParse(tab.state ?? {});
    if (!previous.success || previous.data.connectedDocumentTitle === artifact.title) return;
    tab.setState({ ...previous.data, connectedDocumentTitle: artifact.title });
  }, [artifact, tab]);
  if (state.status === "loading") return <FilePanelLoading />;
  if (state.status === "error" || !artifact) return <PreviewError />;

  return <DocumentPreviewView artifact={artifact} pdf={pdf} download={download} />;
}
function RenderedPdfAsset({
  manifestPath,
  asset,
  serverId,
  workspaceId,
}: {
  manifestPath: string;
  asset: string;
  serverId: string;
  workspaceId: string;
}) {
  const root = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const absolutePath = previewPdfPath(manifestPath, asset) ?? "";
  const target = useMemo(
    () => resolveFilePreviewReadTarget({ path: absolutePath, workspaceRoot: root }),
    [absolutePath, root],
  );
  const active = useRetainedPanelActive();
  const visible = useAppActivelyVisible();
  const handle = useFileHandle({ serverId, target, absolutePath, observing: active && visible });
  const snapshot = useFileHandleSnapshot(handle);
  if (!handle || snapshot.status === "loading") return <FilePanelLoading />;
  if (snapshot.status !== "ready" || snapshot.mimeType !== "application/pdf")
    return <PreviewError />;
  return <PdfFilePanel file={handle.file} />;
}

/** Original file renderings only: no plain-text imitation of pages or workbook cells. */
export function DocumentPreviewView({
  artifact,
  pdf,
  download = null,
}: {
  artifact: DocumentPreviewArtifact;
  pdf: ReactNode;
  download?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [printAction, setPrintAction] = useState<PdfPrintAction | null>(null);
  const print = useStableEvent(() => printAction?.run());
  const workbook = artifact.content.kind === "workbook" ? artifact.content : null;
  const options = useMemo(
    () =>
      workbook ? workbook.sheets.map((sheet) => ({ value: sheet.name, label: sheet.name })) : [],
    [workbook],
  );
  const sheet = workbook
    ? (workbook.sheets.find((entry) => entry.name === selectedName) ?? workbook.sheets[0])
    : null;
  const original = useMutation({
    mutationFn: async () => {
      if (artifact.sourceUrl) await openExternalUrl(artifact.sourceUrl);
    },
  });
  const openOriginal = useStableEvent(() => original.mutate());
  const zoomOut = useStableEvent(() =>
    setZoom((value) => Math.max(0.5, Math.round((value - 0.1) * 10) / 10)),
  );
  const zoomIn = useStableEvent(() =>
    setZoom((value) => Math.min(2, Math.round((value + 0.1) * 10) / 10)),
  );
  const resetZoom = useStableEvent(() => setZoom(1));
  const timestamp = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(artifact.capturedAt)),
    [artifact.capturedAt, i18n.resolvedLanguage],
  );
  let content;
  if (artifact.content.kind === "pdf") content = pdf;
  else if (artifact.content.kind === "word")
    content = <OfficeFrame html={artifact.content.html} zoom={zoom} />;
  else content = sheet ? <OfficeFrame html={sheet.html} zoom={zoom} /> : <PreviewError />;
  return (
    <PdfPrintActionContext.Provider value={setPrintAction}>
      <View style={styles.container} testID="rendered-document-viewer">
        <PaneContentToolbar>
          <View style={styles.toolbar}>
            <Text style={styles.title} numberOfLines={1}>
              {artifact.title}
            </Text>
            <ToolbarControls>
              {artifact.sourceUrl ? (
                <ToolbarButton
                  label={t("documentPreview.openOriginal")}
                  onPress={openOriginal}
                  disabled={original.isPending}
                >
                  <OpenOriginalIcon size={14} />
                </ToolbarButton>
              ) : null}
              {download}
              {artifact.content.kind === "pdf" && isWeb ? (
                <ToolbarButton
                  label={
                    printAction?.busy ? t("pdfViewer.printPreparing") : t("documentPreview.print")
                  }
                  onPress={print}
                  disabled={!printAction?.ready || printAction.busy}
                >
                  <PrintIcon size={14} />
                </ToolbarButton>
              ) : null}
            </ToolbarControls>
          </View>
        </PaneContentToolbar>
        <View style={styles.metadata}>
          <Tooltip>
            <TooltipTrigger>
              <Text style={styles.caption}>{t("documentPreview.snapshot")}</Text>
            </TooltipTrigger>
            <TooltipContent>
              <Text style={styles.caption}>{t("documentPreview.snapshotNotice")}</Text>
            </TooltipContent>
          </Tooltip>
          <Text style={styles.caption}>{timestamp}</Text>
          {artifact.warnings.includes("native-renderer") ? (
            <Tooltip>
              <TooltipTrigger>
                <Text style={styles.caption}>{artifact.content.renderer}</Text>
              </TooltipTrigger>
              <TooltipContent>
                <Text style={styles.caption}>{t("documentPreview.rendererWarning")}</Text>
              </TooltipContent>
            </Tooltip>
          ) : null}
          {artifact.content.kind !== "pdf" ? (
            <View style={styles.zoom}>
              <Button
                size="sm"
                variant="ghost"
                accessibilityLabel={t("documentPreview.zoomOut")}
                onPress={zoomOut}
                disabled={zoom <= 0.5}
              >
                −
              </Button>
              <Button
                size="sm"
                variant="ghost"
                accessibilityLabel={t("documentPreview.zoomReset")}
                onPress={resetZoom}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                size="sm"
                variant="ghost"
                accessibilityLabel={t("documentPreview.zoomIn")}
                onPress={zoomIn}
                disabled={zoom >= 2}
              >
                +
              </Button>
            </View>
          ) : null}
        </View>
        {original.isError ? (
          <Text style={styles.error} accessibilityRole="alert">
            {t("documentPreview.openFailed")}
          </Text>
        ) : null}
        {artifact.warnings.includes("missing-resources") ? (
          <Text style={styles.error}>{t("documentPreview.resourcesWarning")}</Text>
        ) : null}
        <View style={styles.content}>{content}</View>
        {sheet ? (
          <ScrollView
            horizontal
            style={styles.sheetBar}
            contentContainerStyle={styles.sheetTabs}
            testID="workbook-sheet-tabs"
          >
            <SegmentedControl
              options={options}
              value={sheet.name}
              onValueChange={setSelectedName}
              size="sm"
            />
          </ScrollView>
        ) : null}
      </View>
    </PdfPrintActionContext.Provider>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  toolbar: {
    paddingHorizontal: theme.spacing[3],
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  metadata: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  zoom: { flexDirection: "row", alignItems: "center", marginLeft: "auto" },
  content: { flex: 1, minHeight: 0 },
  sheetBar: { flexGrow: 0, borderTopWidth: 1, borderTopColor: theme.colors.border },
  sheetTabs: { padding: theme.spacing[2] },
  error: { color: theme.colors.destructive, padding: theme.spacing[3] },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: theme.spacing[4] },
}));
