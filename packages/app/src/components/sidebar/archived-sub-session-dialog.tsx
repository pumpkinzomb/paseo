import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useViewedAssistantSegment } from "@/default-assistant/conversation";
import { AgentConversationPanel } from "@/panels/agent-panel";
import { PaneProvider, PaneFocusProvider, type PaneContextValue } from "@/panels/pane-context";

const noop = () => {};

/** History belongs to the agent, not to the disposable checkout. Never restore a
 * worktree or offer interactive controls just to review a completed child conversation. */
export function ArchivedSubSessionDialog({
  serverId,
  workspaceId,
  agentId,
  name,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // A modal has no workspace tab to register timeline demand. Subscribe explicitly
  // to stored agent history; this never restores its disposed worktree.
  useViewedAssistantSegment(serverId, `archived-history:${agentId}`, agentId);
  const pane = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId,
      host: "sheet",
      tabId: `archived-history:${agentId}`,
      target: { kind: "agent", agentId },
      openTab: noop,
      openPreferredTarget: noop,
      closeCurrentTab: onClose,
      retargetCurrentTab: noop,
      setCurrentTabState: noop,
      openFileInWorkspace: noop,
      openImportSheet: noop,
    }),
    [serverId, workspaceId, agentId, onClose],
  );
  const focus = useMemo(
    () => ({
      isWorkspaceFocused: true,
      isPaneFocused: true,
      isInteractive: true,
      focusPane: noop,
    }),
    [],
  );
  return (
    <Modal visible onRequestClose={onClose} animationType="fade">
      <View style={styles.container} testID="archived-sub-session-history">
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          <Button variant="secondary" onPress={onClose}>
            {t("common.actions.close")}
          </Button>
        </View>
        <PaneProvider value={pane}>
          <PaneFocusProvider value={focus}>
            <AgentConversationPanel />
          </PaneFocusProvider>
        </PaneProvider>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  title: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
