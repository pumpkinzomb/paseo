import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react-native";
import { useMutation } from "@tanstack/react-query";
import { withUnistyles } from "react-native-unistyles";
import { useFileUrl, type PluginFile } from "@getpaseo/plugin/client";
import { googleDocumentDownloadFormat, type DocumentPreviewArtifact } from "@getpaseo/plugin";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useFileHandle, useFileHandleSnapshot } from "../file";
import { originalDownloadDescriptor, previewOriginalPath, previewDownloadName } from "./model";
import { canDownloadPreview, downloadPreviewFile } from "./download";
export function OriginalDownload({
  artifact,
  manifestPath,
  serverId,
  workspaceId,
}: {
  artifact: DocumentPreviewArtifact;
  manifestPath: string;
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const original = originalDownloadDescriptor(artifact);
  if (!canDownloadPreview) return null;
  if (!original) {
    const expected = googleDocumentDownloadFormat(artifact.sourceUrl);
    return expected ? (
      <ToolbarButton
        label={t("documentPreview.originalUnavailable", { format: expected.toUpperCase() })}
        disabled
        onPress={unavailableDownload}
      >
        <DownloadIcon size={14} />
      </ToolbarButton>
    ) : null;
  }
  const path = previewOriginalPath(manifestPath, original.asset);
  if (!path) return null;
  return (
    <OriginalDownloadFile
      path={path}
      title={artifact.title}
      extension={original.format}
      serverId={serverId}
      workspaceId={workspaceId}
    />
  );
}
function OriginalDownloadFile({
  path,
  title,
  extension,
  serverId,
  workspaceId,
}: {
  path: string;
  title: string;
  extension: string;
  serverId: string;
  workspaceId: string;
}) {
  const root = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const target = useMemo(
    () => resolveFilePreviewReadTarget({ path, workspaceRoot: root }),
    [path, root],
  );
  const active = useRetainedPanelActive();
  const visible = useAppActivelyVisible();
  const handle = useFileHandle({
    serverId,
    target,
    absolutePath: path,
    observing: active && visible,
  });
  const snapshot = useFileHandleSnapshot(handle);
  if (!handle || snapshot.status !== "ready") return null;
  return <DownloadFile file={handle.file} title={title} extension={extension} />;
}
function DownloadFile({
  file,
  title,
  extension,
}: {
  file: PluginFile;
  title: string;
  extension: string;
}) {
  const { t } = useTranslation();
  const source = useFileUrl(file);
  const save = useMutation({
    mutationFn: async () => {
      if (source.status !== "ready") throw Error("Preview file unavailable");
      await downloadPreviewFile(source.url, previewDownloadName(title, extension));
    },
  });
  const download = useStableEvent(() => save.mutate());
  return (
    <ToolbarButton
      label={
        save.isError
          ? t("documentPreview.downloadFailed")
          : t("documentPreview.download", { format: extension.toUpperCase() })
      }
      onPress={download}
      disabled={source.status !== "ready" || save.isPending}
    >
      <DownloadIcon size={14} />
    </ToolbarButton>
  );
}
const DownloadIcon = withUnistyles(Download, mutedIconColorMapping);

function unavailableDownload() {
  return false;
}
