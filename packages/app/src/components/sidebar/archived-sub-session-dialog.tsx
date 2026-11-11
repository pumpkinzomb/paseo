import { useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { DensityIcon } from "@/components/ui/density-icon";
import { X } from "lucide-react-native";
import { useViewedAssistantSegment } from "@/default-assistant/conversation";
import { AgentConversationPanel } from "@/panels/agent-panel";
import { PaneProvider, PaneFocusProvider, type PaneContextValue } from "@/panels/pane-context";

const noop = () => {};

/** History belongs to the agent, not to the disposable checkout. Never restore a
 * worktree or offer interactive controls just to review a completed child conversation. */
export function ArchivedSubSessionHistory({
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
  // History has no workspace tab to register timeline demand. Subscribe explicitly
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
  const closeButton = useMemo(
    () => (
      <ToolbarButton label={t("common.actions.close")} onPress={onClose}>
        <DensityIcon icon={X} size="md" color="foregroundMuted" />
      </ToolbarButton>
    ),
    [t, onClose],
  );
  return (
    <View style={styles.container} testID="archived-sub-session-history">
      <MenuHeader title={name} rightContent={closeButton} />
      <PaneProvider value={pane}>
        <PaneFocusProvider value={focus}>
          <AgentConversationPanel />
        </PaneFocusProvider>
      </PaneProvider>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
}));
