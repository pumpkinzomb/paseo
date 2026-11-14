import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { selectLeadWork } from "@/default-assistant/room-leads";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AssistantConversation } from "@getpaseo/protocol/messages";
import { useRoomLeads } from "@/default-assistant/use-room-leads";
import { navigateAssistantConversation } from "@/default-assistant/conversation-navigation";
import { useAgentDescriptor } from "@/agent-presentation";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  useWorkspaceLayoutStore,
  collectAllTabs,
  findPaneById,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { DensityIcon } from "@/components/ui/density-icon";

export function SidebarRoomLeads({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const query = useRoomLeads(serverId, workspaceId);
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const layout = useWorkspaceLayoutStore((state) =>
    key ? state.layoutByWorkspace[key] : undefined,
  );
  const order = layout
    ? collectAllTabs(layout.root).map((tab) =>
        tab.target.kind === "agent" ? tab.target.agentId : "",
      )
    : [];
  const leads = [...(query.data ?? [])].sort((a, b) => {
    const ai = order.indexOf(a.segments[0]!.agentId);
    const bi = order.indexOf(b.segments[0]!.agentId);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
  });
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (!query.available) return null;
  if (!query.connected && !query.data)
    return <Text style={styles.name}>{t("workspace.terminal.hostDisconnected")}</Text>;
  if (query.isError)
    return (
      <View style={styles.group}>
        <Text style={styles.name}>{query.error.message}</Text>
        <PressHighlight onPress={retry}>
          <Text style={styles.name}>{t("common.actions.retry")}</Text>
        </PressHighlight>
      </View>
    );
  if (query.isPending) return <Text style={styles.name}>{t("common.loading")}</Text>;
  return (
    <View style={styles.group} testID={`sidebar-room-leads-${serverId}:${workspaceId}`}>
      {leads.map((conversation) => (
        <LeadRow
          key={conversation.logicalId}
          serverId={serverId}
          workspaceId={workspaceId}
          conversation={conversation}
        />
      ))}
    </View>
  );
}

function LeadRow({
  serverId,
  workspaceId,
  conversation,
}: {
  serverId: string;
  workspaceId: string;
  conversation: AssistantConversation;
}) {
  const agentId = conversation.segments[0]!.agentId;
  const descriptor = useAgentDescriptor({ kind: "agent", agentId }, { serverId });
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const activeWorkspace = useActiveWorkspaceSelection();
  const tabSelected = useWorkspaceLayoutStore((state) => {
    const layout = key ? state.layoutByWorkspace[key] : undefined;
    const pane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
    return (
      (layout ? collectAllTabs(layout.root) : []).some(
        (tab) =>
          tab.tabId === pane?.focusedTabId &&
          tab.target.kind === "agent" &&
          tab.target.agentId === agentId,
      ) ?? false
    );
  });
  const selected =
    tabSelected &&
    activeWorkspace?.serverId === serverId &&
    activeWorkspace?.workspaceId === workspaceId;
  const open = useCallback(
    () => navigateAssistantConversation({ serverId, conversation }),
    [serverId, conversation],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <>
      <PressHighlight
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={descriptor.tooltip}
        accessibilityState={accessibilityState}
        aria-selected={selected}
        testID={`sidebar-lead-${serverId}:${agentId}`}
        style={[styles.row, selected && styles.selected]}
      >
        <DensityIcon icon={descriptor.icon} size="sm" color="foregroundMuted" />
        <Text style={styles.name} numberOfLines={1}>
          {descriptor.label}
        </Text>
      </PressHighlight>
      <LeadWork serverId={serverId} conversation={conversation} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { paddingLeft: theme.spacing[4] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 36,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  selected: { backgroundColor: theme.colors.surface2 },
  name: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));

/** Parent-address labels are authoritative; paths and room names never establish ownership. */
function LeadWork({
  serverId,
  conversation,
}: {
  serverId: string;
  conversation: AssistantConversation;
}) {
  const children = useSessionStore(
    useShallow((state) =>
      selectLeadWork(state.sessions[serverId]?.agents.values() ?? [], serverId, conversation),
    ),
  );
  return (
    <View style={styles.group}>
      {children.map((agent) => (
        <LeadWorkRow key={agent.id} agent={agent} serverId={serverId} />
      ))}
    </View>
  );
}

function LeadWorkRow({ agent, serverId }: { agent: Agent; serverId: string }) {
  const open = useCallback(
    () =>
      navigateToAgent({ serverId, agentId: agent.id, workspaceId: agent.workspaceId, pin: true }),
    [serverId, agent.id, agent.workspaceId],
  );
  return (
    <PressHighlight
      onPress={open}
      style={styles.row}
      testID={`sidebar-lead-work-${serverId}:${agent.id}`}
    >
      <Text style={styles.name} numberOfLines={1}>
        {agent.title || agent.id}
      </Text>
    </PressHighlight>
  );
}
