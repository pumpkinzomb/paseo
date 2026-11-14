import { ConversationTreeGroup, DevelopmentTreeGroups } from "@/development-review/tree";
import { useDevelopmentReviewSelection } from "@/development-review/selection";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { Text, View } from "react-native";
import { Files } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedFiles = withUnistyles(Files);
const filesPanelPresentation = {
  label: (t) => t("panels.files.label"),
  subtitle: (t) => t("panels.files.subtitle"),
  tooltip: (t) => t("panels.files.tooltip"),
  icon: ThemedFiles,
} satisfies PanelPresentation;

function FilesPanel() {
  const { serverId, workspaceId } = usePaneContext();
  const client = useHostRuntimeClient(serverId);
  if (client?.getLastServerInfoMessage()?.features?.developmentReview !== true)
    return <ConversationFilesPanel />;
  return <UnifiedFilesPanel key={`${serverId}:${workspaceId}`} />;
}
function UnifiedFilesPanel() {
  const { serverId, workspaceId } = usePaneContext();
  const path = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const [expanded, setExpanded] = useState(true);
  const select = useDevelopmentReviewSelection((state) => state.select);
  const focus = useCallback(
    () => select(JSON.stringify([serverId, workspaceId]), undefined),
    [select, serverId, workspaceId],
  );
  const toggle = useCallback(() => {
    focus();
    setExpanded((value) => !value);
  }, [focus]);
  const header = useMemo(
    () => (
      <ConversationTreeGroup path={path} expanded={expanded} onPress={toggle} onFocus={focus} />
    ),
    [path, expanded, toggle, focus],
  );
  const footer = useMemo(() => <DevelopmentTreeGroups />, []);
  return (
    <ConversationFilesPanel
      treeHeader={header}
      treeFooter={footer}
      treeExpanded={expanded}
      onScopeFocus={focus}
    />
  );
}
interface ConversationTreeProps {
  treeHeader?: ReactElement;
  treeFooter?: ReactElement;
  treeExpanded?: boolean;
  onScopeFocus?: () => void;
}
function ConversationFilesPanel(props: ConversationTreeProps) {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, openPreferredTarget, openTargetToSide } = usePaneContext();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  invariant(target.kind === "files", "FilesPanel requires files target");
  const onOpenFile = useCallback(
    (path: string) => openPreferredTarget({ kind: "file", path }, "explorerFiles"),
    [openPreferredTarget],
  );
  const onOpenFileToSide = useCallback(
    (path: string) => openTargetToSide?.({ kind: "file", path }),
    [openTargetToSide],
  );
  if (!workspaceRoot) {
    return (
      <View style={styles.centerState}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <FileExplorerPane
      {...props}
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      onOpenFile={onOpenFile}
      onOpenFileToSide={openTargetToSide ? onOpenFileToSide : undefined}
      onAddToChat={canAddToChat ? addFile : undefined}
    />
  );
}

export const filesPanelRegistration = definePanel("files", {
  component: FilesPanel,
  presentation: filesPanelPresentation,
});

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
}));
