import { FileText } from "lucide-react-native";
import { Text, View } from "react-native";
import { useMemo } from "react";
import invariant from "tiny-invariant";
import { useTranslation } from "react-i18next";
import { isManagedPreviewPath } from "@/file-panels/document-preview/model";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { PanelDescriptorContext } from "@/panels/panel-registry";
import { FilePane } from "@/file-pane/pane";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { createMaterialFileIcon } from "@/components/material-file-icon";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function useFilePanelDescriptor(
  target: { kind: "file"; path: string },
  context: PanelDescriptorContext,
) {
  const { t } = useTranslation();
  const workspaceKey = buildWorkspaceTabPersistenceKey(context);
  const connectedTitle = useWorkspaceLayoutStore((state) => {
    const layout = workspaceKey ? state.layoutByWorkspace[workspaceKey] : null;
    const tabState = layout
      ? collectAllTabs(layout.root).find((tab) => tab.tabId === context.tabId)?.state
      : null;
    if (!tabState || typeof tabState !== "object" || Array.isArray(tabState)) return null;
    return typeof tabState.connectedDocumentTitle === "string"
      ? tabState.connectedDocumentTitle
      : null;
  });
  const fileName = target.path.split("/").findLast(Boolean) ?? target.path;
  const icon = useMemo(() => createMaterialFileIcon(fileName), [fileName]);
  return {
    label: isManagedPreviewPath(target.path)
      ? (connectedTitle ?? t("documentPreview.document"))
      : fileName,
    subtitle: target.path,
    tooltip: target.path,
    titleState: "ready" as const,
    icon: isManagedPreviewPath(target.path) ? FileText : icon,
    statusBucket: null,
  };
}

function FilePanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, panelRevision } = usePaneContext();
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  invariant(target.kind === "file", "FilePanel requires file target");
  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <FilePane
      serverId={serverId}
      workspaceRoot={workspaceDirectory}
      location={target}
      navigationRevision={panelRevision ?? 0}
    />
  );
}

export const filePanelRegistration = definePanel("file", {
  component: FilePanel,
  useDescriptor: useFilePanelDescriptor,
});
