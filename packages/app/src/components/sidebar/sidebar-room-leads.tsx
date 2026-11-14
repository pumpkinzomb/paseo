import { Trash2 } from "lucide-react-native";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { DensityIcon } from "@/components/ui/density-icon";
import { useDeleteWorkspaceSessions } from "@/hooks/use-delete-workspace-sessions";
import { openWorkspaceTargetAtLocation } from "@/workspace-tabs/open-beside";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useCallback, useMemo, type ComponentProps, type ReactNode } from "react";
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
import { SidebarSubSessionGroup, ArchivedSubSessionRow } from "./sidebar-sub-session-group";
import { useSidebarRoomWork } from "./sidebar-room-work-context";
import { partitionRoomWork, leadCollapseKey } from "./sidebar-sub-sessions";
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
  const assistantTree =
    query.available ||
    placements.some(
      (item) => entries.get(item.workspaceKey)?.leadAssociation?.roomWorkspaceId === workspaceId,
    ) ||
    archivedSubSessions.some((item) => item.leadAssociation?.roomWorkspaceId === workspaceId);
  const evidenceIds = useSessionStore(
    useShallow((state) => {
      if (!assistantTree || placements.length === 0) return [];
      const session = state.sessions[serverId],
        ids = new Set(placements.map((item) => item.workspaceId)),
        found = new Set<string>();
      for (const agents of [session?.agents, session?.agentDetails])
        for (const agent of agents?.values() ?? [])
          if (!agent.background && agent.workspaceId && ids.has(agent.workspaceId))
            found.add(agent.workspaceId);
      return [...found];
    }),
  );
  const workspaceWork = placements
    .filter((item) => {
      const entry = entries.get(item.workspaceKey);
      if (assistantTree && entry?.workspacePurpose === "source" && entry.sessionCount === 0)
        return false;
      return (
        !assistantTree ||
        entry?.sessionCount !== 0 ||
        entry.workspacePurpose === "planned" ||
        !entry.workspacePurpose ||
        evidenceIds.includes(item.workspaceId)
      );
    })
    .map((placement) => ({
      placement,
      creatorAgent: entries.get(placement.workspaceKey)?.creatorAgent,
      leadAssociation: entries.get(placement.workspaceKey)?.leadAssociation,
    }));
  const unclassified = assistantTree
    ? workspaceWork.filter((item) => {
        const entry = entries.get(item.placement.workspaceKey);
        return (
          !(entry?.sessionCount ?? 0) &&
          !evidenceIds.includes(item.placement.workspaceId) &&
          !(entry?.workspacePurpose === "planned" && entry.sessionCount === 0)
        );
      })
    : [];
  const partition = partitionRoomWork(
    serverId,
    leads,
    workspaceWork.filter((item) => !unclassified.includes(item)),
    workspaceId,
  );
  const recoveryItems = [...partition.unassigned, ...unclassified];
  const sessionArchives = archivedSubSessions.filter(
    (item) => !assistantTree || item.agentId !== null || item.sessionCount !== 0,
  );
  const uncertainArchives = assistantTree
    ? sessionArchives.filter((item) => item.agentId === null)
    : [];
  const archivePartition = partitionRoomWork(
    serverId,
    leads,
    sessionArchives.filter((item) => !uncertainArchives.includes(item)),
    workspaceId,
  );
  const recoveryArchives = [...archivePartition.unassigned, ...uncertainArchives];
  const renderRoomRow = useCallback(
    (placement: SidebarWorkspacePlacement) => {
      const entry = entries.get(placement.workspaceKey);
      return assistantTree &&
        entry &&
        !(entry.sessionCount ?? 0) &&
        !evidenceIds.includes(entry.workspaceId) ? (
        <RoomWorkspaceRow
          key={placement.workspaceKey}
          entry={entry}
          roomWorkspaceId={workspaceId}
        />
      ) : (
        renderRow(placement)
      );
    },
    [assistantTree, entries, evidenceIds, workspaceId, renderRow],
  );
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  let recovery: ReactNode = null;
  if (recoveryItems.length || recoveryArchives.length)
    recovery = assistantTree ? (
      <View testID={`sidebar-room-recovery-${serverId}:${workspaceId}`}>
        <Text style={styles.commonLabel} accessibilityRole="alert">
          {t("sidebar.workspace.subSessions.ownershipUnavailable")}
        </Text>
        {recoveryItems.map((item) => renderRoomRow(item.placement))}
        {recoveryArchives.map((item) => (
          <ArchivedSubSessionRow
            key={item.workspaceId}
            serverId={serverId}
            parentWorkspaceId={workspaceId}
            subSession={item}
            historyRecord={!item.agentId}
            scopedDeletion
          />
        ))}
      </View>
    ) : (
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
    );
  return (
    <>
      {query.available ? (
        <View style={styles.group} testID={`sidebar-room-leads-${serverId}:${workspaceId}`}>
          <RoomLeadLoadState query={query} retry={retry} />
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
              renderRow={renderRoomRow}
            />
          ))}
        </View>
      ) : null}
      {recovery}
    </>
  );
}

function RoomLeadLoadState({
  query,
  retry,
}: {
  query: ReturnType<typeof useRoomLeads>;
  retry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
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
    </>
  );
}

function RoomWorkspaceRow({
  entry,
  roomWorkspaceId,
}: {
  entry: SidebarWorkspaceEntry;
  roomWorkspaceId: string;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => {
    openWorkspaceTargetAtLocation({
      workspaceKey: entry.workspaceKey,
      target: { kind: "files" },
      location: "main",
    });
    navigateToWorkspace({ serverId: entry.serverId, workspaceId: entry.workspaceId });
  }, [entry.workspaceKey, entry.serverId, entry.workspaceId]);
  const options = useMemo(
    () => ({
      historyScope: {
        roomWorkspaceId,
        leadAssociation: entry.leadAssociation,
        itemKind: "planned" as const,
      },
    }),
    [roomWorkspaceId, entry.leadAssociation],
  );
  const deletion = useDeleteWorkspaceSessions(
    entry.serverId,
    entry.workspaceId,
    undefined,
    options,
  );
  return (
    <View style={styles.row}>
      <PressHighlight
        style={styles.title}
        onPress={open}
        accessibilityRole="button"
        testID={`sidebar-room-workspace-${entry.workspaceId}`}
      >
        <Text style={styles.name} numberOfLines={1}>
          {entry.name}
        </Text>
        <Text style={styles.count}>
          {t(
            entry.workspacePurpose === "planned" && entry.sessionCount === 0
              ? "sidebar.workspace.subSessions.notStarted"
              : "sidebar.workspace.subSessions.needsReview",
          )}
        </Text>
      </PressHighlight>
      {entry.workspacePurpose === "planned" && entry.sessionCount === 0 && deletion.remove ? (
        <ToolbarButton
          label={t("workspaceSessionDeletion.historyMenu")}
          onPress={deletion.remove}
          disabled={deletion.pending}
          testID={`sidebar-planned-remove-${entry.workspaceId}`}
        >
          <DensityIcon icon={Trash2} size="sm" color="foregroundMuted" />
        </ToolbarButton>
      ) : null}
    </View>
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
  const associations = useMemo(
    () =>
      new Map(
        [...workspaceEntriesByKey.values()]
          .filter((item) => item.serverId === serverId && item.leadAssociation)
          .map((item) => [item.workspaceId, item.leadAssociation!]),
      ),
    [workspaceEntriesByKey, serverId],
  );
  const children = useSessionStore(
    useShallow((state) =>
      selectLeadWork(state.sessions[serverId]?.agents.values() ?? [], serverId, conversation, {
        roomWorkspaceId: workspaceId,
        associations,
      }),
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
          assistantSessionTree
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
