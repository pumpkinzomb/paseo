import { useCallback, useMemo, type ComponentProps } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import type { AssistantConversation } from "@getpaseo/protocol/messages";
import {
  useSessionStore,
  selectAgentTurnPresentation,
  type Agent,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { selectLeadWork } from "@/default-assistant/room-leads";
import { useRoomLeads } from "@/default-assistant/use-room-leads";
import { navigateAssistantConversation } from "@/default-assistant/conversation-navigation";
import { useAgentDescriptor } from "@/agent-presentation";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusIcon } from "@/components/status-icon";
import { StatusRing } from "@/components/status-ring";
import { TreeChevron } from "@/components/tree-primitives";
import {
  useWorkspaceLayoutStore,
  collectAllTabs,
  findPaneById,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  aggregateSidebarStateBuckets,
  deriveSidebarStateBucket,
} from "@/utils/sidebar-agent-state";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { SidebarSubSessionGroup } from "./sidebar-sub-session-group";
import { useSidebarRoomWork } from "./sidebar-room-work-context";
import {
  partitionRoomWork,
  leadCollapseKey,
  isRoomSessionWorkspaceVisible,
} from "./sidebar-sub-sessions";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";

type Archived = NonNullable<WorkspaceDescriptor["archivedSubSessions"]>[number];
const EMPTY_ARCHIVED: readonly Archived[] = [];
const EMPTY_PLACEMENTS: readonly SidebarWorkspacePlacement[] = [];
const EMPTY_ENTRIES = new Map<string, SidebarWorkspaceEntry>();
const noRow = () => null;

export function SidebarRoomLeads({
  serverId,
  workspaceId,
  parentName = "",
  archivedSubSessions = EMPTY_ARCHIVED,
}: {
  serverId: string;
  workspaceId: string;
  parentName?: string;
  archivedSubSessions?: readonly Archived[];
}) {
  const { t } = useTranslation();
  const query = useRoomLeads(serverId, workspaceId);
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const roomWork = useSidebarRoomWork(`${serverId}:${workspaceId}`);
  const placements = roomWork?.subSessions ?? EMPTY_PLACEMENTS;
  const entries = roomWork?.workspaceEntriesByKey ?? EMPTY_ENTRIES;
  const renderRow = roomWork?.renderRow ?? noRow;
  const layout = useWorkspaceLayoutStore((state) =>
    key ? state.layoutByWorkspace[key] : undefined,
  );
  const order = layout
    ? collectAllTabs(layout.root).map((tab) =>
        tab.target.kind === "agent" ? tab.target.agentId : "",
      )
    : [];
  const leads = [...(query.data ?? [])].sort((a, b) => {
    const ai = order.indexOf(a.segments[0]!.agentId),
      bi = order.indexOf(b.segments[0]!.agentId);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
  });
  const zeroSessionIds = useMemo(
    () =>
      new Set([
        ...placements
          .filter((item) => entries.get(item.workspaceKey)?.sessionCount === 0)
          .map((item) => item.workspaceId),
        ...archivedSubSessions
          .filter((item) => item.sessionCount === 0)
          .map((item) => item.workspaceId),
      ]),
    [placements, entries, archivedSubSessions],
  );
  const agentWorkspaceIds = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const evidence = new Set<string>();
      // Exact-host cached records can contradict an older zero-count projection. Never infer
      // absence from this partial inventory, or scan other hosts to establish room membership.
      for (const records of [session?.agents, session?.agentDetails]) {
        for (const agent of records?.values() ?? []) {
          if (!agent.background && agent.workspaceId && zeroSessionIds.has(agent.workspaceId)) {
            evidence.add(agent.workspaceId);
          }
        }
      }
      return [...evidence];
    }),
  );
  const hasLeads = leads.length > 0;
  const workspaceWork = placements
    .filter((placement) =>
      isRoomSessionWorkspaceVisible({
        hasLeads,
        sessionCount: entries.get(placement.workspaceKey)?.sessionCount,
        hasAgentEvidence: agentWorkspaceIds.includes(placement.workspaceId),
      }),
    )
    .map((placement) => ({
      placement,
      creatorAgent: entries.get(placement.workspaceKey)?.creatorAgent,
    }));
  const partition = partitionRoomWork(serverId, leads, workspaceWork);
  const archivePartition = partitionRoomWork(
    serverId,
    leads,
    archivedSubSessions.filter((item) =>
      isRoomSessionWorkspaceVisible({
        hasLeads,
        sessionCount: item.sessionCount,
        hasAgentEvidence: item.agentId !== null || agentWorkspaceIds.includes(item.workspaceId),
      }),
    ),
  );
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  return (
    <>
      {query.available ? (
        <View style={styles.group} testID={`sidebar-room-leads-${serverId}:${workspaceId}`}>
          {query.isError ? (
            <>
              <Text style={styles.name}>{query.error.message}</Text>
              <PressHighlight onPress={retry}>
                <Text style={styles.name}>{t("common.actions.retry")}</Text>
              </PressHighlight>
            </>
          ) : null}
          {!query.connected && !query.data ? (
            <Text style={styles.name}>{t("workspace.terminal.hostDisconnected")}</Text>
          ) : null}
          {query.connected && query.isPending ? (
            <Text style={styles.name}>{t("common.loading")}</Text>
          ) : null}
          {leads.map((conversation) => (
            <LeadRow
              key={conversation.logicalId}
              serverId={serverId}
              workspaceId={workspaceId}
              conversation={conversation}
              subSessions={(partition.byLead.get(conversation.logicalId) ?? []).map(
                (item) => item.placement,
              )}
              archivedSubSessions={
                archivePartition.byLead.get(conversation.logicalId) ?? EMPTY_ARCHIVED
              }
              workspaceEntriesByKey={entries}
              renderRow={renderRow}
            />
          ))}
        </View>
      ) : null}
      {partition.unassigned.length || archivePartition.unassigned.length ? (
        <View testID={`sidebar-room-unassigned-${serverId}:${workspaceId}`}>
          {query.available ? (
            <Text style={styles.commonLabel}>{t("sidebar.workspace.subSessions.unassigned")}</Text>
          ) : null}
          <SidebarSubSessionGroup
            serverId={serverId}
            parentKey={`${serverId}:${workspaceId}`}
            parentName={parentName}
            subSessions={partition.unassigned.map((item) => item.placement)}
            archivedSubSessions={archivePartition.unassigned}
            workspaceEntriesByKey={entries}
            renderRow={renderRow}
            strictWorkspaceScope
            allowBulkDeletion={false}
          />
        </View>
      ) : null}
    </>
  );
}

type WorkProps = Pick<
  ComponentProps<typeof SidebarSubSessionGroup>,
  "subSessions" | "archivedSubSessions" | "workspaceEntriesByKey" | "renderRow"
>;
function LeadRow({
  serverId,
  workspaceId,
  conversation,
  subSessions,
  archivedSubSessions = EMPTY_ARCHIVED,
  workspaceEntriesByKey,
  renderRow,
}: {
  serverId: string;
  workspaceId: string;
  conversation: AssistantConversation;
} & WorkProps) {
  const { t } = useTranslation();
  const agentId = conversation.segments[0]!.agentId;
  const descriptor = useAgentDescriptor({ kind: "agent", agentId }, { serverId });
  const collapseKey = leadCollapseKey(serverId, workspaceId, conversation.logicalId);
  const collapsed = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedWorkspaceGroupKeys.has(collapseKey),
  );
  const toggle = useCallback(
    () => useSidebarCollapsedSectionsStore.getState().toggleWorkspaceGroupCollapsed(collapseKey),
    [collapseKey],
  );
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const activeWorkspace = useActiveWorkspaceSelection();
  const tabSelected = useWorkspaceLayoutStore((state) => {
    const layout = key ? state.layoutByWorkspace[key] : undefined;
    const pane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
    return (layout ? collectAllTabs(layout.root) : []).some(
      (tab) =>
        tab.tabId === pane?.focusedTabId &&
        tab.target.kind === "agent" &&
        tab.target.agentId === agentId,
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
  const expandedState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const children = useSessionStore(
    useShallow((state) =>
      selectLeadWork(state.sessions[serverId]?.agents.values() ?? [], serverId, conversation),
    ),
  );
  const buckets = useSessionStore(
    useShallow((state) =>
      children.map((agent) =>
        deriveSidebarStateBucket({
          status: selectAgentTurnPresentation(state.sessions[serverId], agent.id).isActive
            ? "running"
            : agent.status,
          backgroundWork: agent.backgroundWork,
          pendingPermissionCount: agent.pendingPermissions.length,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
        }),
      ),
    ),
  );
  // An unassigned/shared workspace does not replace a child's proven agent parentage.
  const representedWorkspaceIds = new Set([
    ...subSessions.map((item) => item.workspaceId),
    ...archivedSubSessions.map((item) => item.workspaceId),
  ]);
  const direct = children.filter(
    (agent) => !agent.workspaceId || !representedWorkspaceIds.has(agent.workspaceId),
  );
  const directRows = (done: boolean) =>
    direct
      .filter((agent) => (buckets[children.indexOf(agent)] === "done") === done)
      .map((agent) => <LeadWorkRow key={agent.id} agent={agent} serverId={serverId} />);
  const delegatedBuckets = [
    ...buckets,
    ...subSessions.map(
      (item) => workspaceEntriesByKey.get(item.workspaceKey)?.statusBucket ?? "done",
    ),
  ];
  const workBucket = aggregateSidebarStateBuckets(delegatedBuckets);
  const count =
    direct.length +
    subSessions.length +
    archivedSubSessions.filter((item) => (item.sessionCount ?? 0) > 0 || item.agentId).length;
  return (
    <>
      <View style={[styles.row, selected && styles.selected]}>
        <PressHighlight
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={descriptor.label}
          accessibilityState={expandedState}
          aria-expanded={!collapsed}
          testID={`sidebar-lead-toggle-${serverId}:${agentId}`}
          style={styles.chevron}
        >
          <TreeChevron expanded={!collapsed} />
        </PressHighlight>
        <PressHighlight
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={descriptor.tooltip}
          accessibilityState={accessibilityState}
          aria-selected={selected}
          testID={`sidebar-lead-${serverId}:${agentId}`}
          style={styles.title}
        >
          {descriptor.statusBucket !== "done" ? (
            <View testID={`sidebar-lead-status-${agentId}:${descriptor.statusBucket ?? "loading"}`}>
              {descriptor.statusBucket === null ? (
                <StatusRing />
              ) : (
                <StatusIcon statusBucket={descriptor.statusBucket} backdrop="surfaceSidebar">
                  {null}
                </StatusIcon>
              )}
            </View>
          ) : null}
          <Text style={styles.name} numberOfLines={1}>
            {descriptor.label}
          </Text>
        </PressHighlight>
        {count ? (
          <View
            accessibilityLabel={t("sidebar.workspace.subSessions.delegatedCount", { count })}
            testID={`sidebar-lead-work-status-${agentId}:${workBucket}`}
          >
            <StatusIcon statusBucket={workBucket} backdrop="surfaceSidebar" size={18}>
              <Text style={styles.count}>{count}</Text>
            </StatusIcon>
          </View>
        ) : null}
      </View>
      {!collapsed ? (
        <SidebarSubSessionGroup
          serverId={serverId}
          parentKey={`${serverId}:${workspaceId}`}
          groupKey={`${serverId}:${workspaceId}:lead:${conversation.logicalId}`}
          parentName={descriptor.label}
          subSessions={subSessions}
          archivedSubSessions={archivedSubSessions}
          workspaceEntriesByKey={workspaceEntriesByKey}
          renderRow={renderRow}
          activeAgentRows={directRows(false)}
          doneAgentRows={directRows(true)}
          strictWorkspaceScope
        />
      ) : null}
    </>
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
  title: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 36,
  },
  chevron: { justifyContent: "center", alignItems: "center", minHeight: 36 },
  selected: { backgroundColor: theme.colors.surface2 },
  name: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  commonLabel: {
    paddingLeft: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
