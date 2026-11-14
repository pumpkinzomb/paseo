import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Archive, Trash2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { DensityIcon } from "@/components/ui/density-icon";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { density, densityIconBox } from "@/styles/density";
import { usePathname, useRouter } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useDeleteCompletedSubSessions } from "@/hooks/use-delete-completed-sub-sessions";
import { useDeleteWorkspaceSessions } from "@/hooks/use-delete-workspace-sessions";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { SidebarGroupToggleRow } from "./sidebar-group-toggle-row";
import { groupSubSessionsByActivity } from "./sidebar-sub-sessions";

type ArchivedSubSession = NonNullable<WorkspaceDescriptor["archivedSubSessions"]>[number];

const EMPTY_ARCHIVED: readonly ArchivedSubSession[] = [];

/**
 * The sub-sessions a session's agents created, drawn under its row. Live sub-sessions stay in
 * view with their own status; finished and cleaned-up ones fold into a collapsed "Done" toggle so
 * the parent keeps a record of the work without the list growing with every helper it started.
 */
export function SidebarSubSessionGroup({
  serverId,
  parentKey,
  parentName,
  subSessions,
  archivedSubSessions = EMPTY_ARCHIVED,
  workspaceEntriesByKey,
  renderRow,
  groupKey = parentKey,
  strictWorkspaceScope = false,
  allowBulkDeletion = true,
  activeAgentRows,
  doneAgentRows,
}: {
  serverId: string;
  parentKey: string;
  parentName: string;
  subSessions: readonly SidebarWorkspacePlacement[];
  archivedSubSessions?: readonly ArchivedSubSession[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  renderRow: (placement: SidebarWorkspacePlacement) => ReactNode;
  groupKey?: string;
  strictWorkspaceScope?: boolean;
  allowBulkDeletion?: boolean;
  activeAgentRows?: readonly ReactNode[];
  doneAgentRows?: readonly ReactNode[];
}) {
  const { t } = useTranslation();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const { active, done } = useMemo(
    () =>
      groupSubSessionsByActivity({
        children: subSessions,
        workspaceEntriesByKey,
      }),
    [subSessions, workspaceEntriesByKey],
  );
  const toggleDone = useCallback(() => setDoneExpanded((expanded) => !expanded), []);
  const archivedSessions = archivedSubSessions.filter(
    (item) => item.sessionCount !== 0 && (item.agentId !== null || (item.sessionCount ?? 0) > 0),
  );
  const workspaceHistory = archivedSubSessions.filter((item) => !archivedSessions.includes(item));
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const toggleHistory = useCallback(() => setHistoryExpanded((value) => !value), []);
  const doneCount = done.length + archivedSessions.length + (doneAgentRows?.length ?? 0);

  const completedIds = useMemo(
    () => [
      ...new Set([
        ...done.map((item) => item.workspaceId),
        ...archivedSessions.map((item) => item.workspaceId),
      ]),
    ],
    [done, archivedSessions],
  );
  const parentWorkspaceId = parentKey.slice(serverId.length + 1);
  const pathname = usePathname();
  const returnFromDeletedHistory = useCallback(
    (removed: readonly string[]) => {
      const shown = archivedSubSessions.find(
        (item) =>
          item.agentId &&
          pathname ===
            `/h/${encodeURIComponent(serverId)}/history/${encodeURIComponent(item.agentId)}`,
      );
      if (shown && removed.includes(shown.workspaceId))
        navigateToWorkspace({ serverId, workspaceId: parentWorkspaceId });
    },
    [archivedSubSessions, pathname, parentWorkspaceId, serverId],
  );
  const bulkDeletion = useDeleteCompletedSubSessions(
    serverId,
    parentWorkspaceId,
    completedIds,
    returnFromDeletedHistory,
    { restrictToTargets: strictWorkspaceScope, ownerKey: groupKey },
  );

  return (
    <View
      role="group"
      accessibilityLabel={t("sidebar.workspace.subSessions.group", {
        name: parentName,
      })}
      style={styles.group}
      testID={`sidebar-sub-sessions-${groupKey}`}
    >
      {activeAgentRows}
      {active.map((placement) => renderRow(placement))}
      {doneCount > 0 ? (
        <View style={styles.archivedRowContainer}>
          <View style={styles.toggleSlot}>
            <SidebarGroupToggleRow
              expanded={doneExpanded}
              onPress={toggleDone}
              label={t("sidebar.workspace.subSessions.done", {
                count: doneCount,
              })}
              testID={`sidebar-sub-sessions-done-toggle-${groupKey}`}
            />
          </View>
          {allowBulkDeletion && bulkDeletion.remove && !doneAgentRows?.length ? (
            <ToolbarButton
              label={t("workspaceSessionDeletion.completedMenu")}
              onPress={bulkDeletion.remove}
              disabled={bulkDeletion.pending}
              testID={`sidebar-sub-sessions-delete-done-${groupKey}`}
            >
              <DensityIcon icon={Trash2} size="sm" color="foregroundMuted" />
            </ToolbarButton>
          ) : null}
        </View>
      ) : null}
      {doneExpanded ? (
        <View testID={`sidebar-sub-sessions-done-${groupKey}`}>
          {doneAgentRows}
          {done.map((placement) => renderRow(placement))}
          {archivedSessions.map((subSession) => (
            <ArchivedSubSessionRow
              key={subSession.workspaceId}
              serverId={serverId}
              subSession={subSession}
              parentWorkspaceId={parentWorkspaceId}
            />
          ))}
        </View>
      ) : null}
      {workspaceHistory.length ? (
        <>
          <SidebarGroupToggleRow
            expanded={historyExpanded}
            onPress={toggleHistory}
            label={t("sidebar.workspace.subSessions.workspaceHistory", {
              count: workspaceHistory.length,
            })}
            testID={`sidebar-workspace-history-toggle-${groupKey}`}
          />
          {historyExpanded
            ? workspaceHistory.map((subSession) => (
                <ArchivedSubSessionRow
                  key={subSession.workspaceId}
                  serverId={serverId}
                  subSession={subSession}
                  parentWorkspaceId={parentWorkspaceId}
                  allowDeletion={false}
                />
              ))
            : null}
        </>
      ) : null}
    </View>
  );
}

/**
 * A sub-session whose workspace was archived. Its agent's timeline survives the cleanup, so the
 * row opens read-only history inside the regular host shell, preserving the sidebar.
 */
function ArchivedSubSessionRow({
  serverId,
  subSession,
  parentWorkspaceId,
  allowDeletion = true,
}: {
  serverId: string;
  subSession: ArchivedSubSession;
  parentWorkspaceId: string;
  allowDeletion?: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const onDeleted = useCallback(() => {
    if (
      pathname ===
      `/h/${encodeURIComponent(serverId)}/history/${encodeURIComponent(subSession.agentId ?? "")}`
    ) {
      navigateToWorkspace({ serverId, workspaceId: parentWorkspaceId });
    }
  }, [pathname, serverId, parentWorkspaceId, subSession.agentId]);
  const deletion = useDeleteWorkspaceSessions(serverId, subSession.workspaceId, onDeleted);
  const handlePress = useCallback(() => {
    if (subSession.agentId) {
      router.push({
        pathname: "/h/[serverId]/history/[agentId]",
        params: {
          serverId,
          agentId: subSession.agentId,
          workspaceId: subSession.workspaceId,
          parentWorkspaceId,
          name: subSession.name,
        },
      });
      return;
    }
  }, [router, serverId, subSession, parentWorkspaceId]);
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.archivedRow,
      hovered && !pressed && styles.archivedRowHovered,
      pressed && styles.archivedRowPressed,
    ],
    [],
  );
  const archivedLabel = t("sidebar.workspace.subSessions.archivedAgent");

  return (
    <View>
      <View style={styles.archivedRowContainer}>
        <PressHighlight
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={`${subSession.name}, ${archivedLabel}`}
          onPress={handlePress}
          disabled={!subSession.agentId}
          style={rowStyle}
          testID={`sidebar-archived-sub-session-${serverId}:${subSession.workspaceId}`}
        >
          <View style={styles.iconSlot}>
            <DensityIcon icon={Archive} size="sm" color="foregroundMuted" />
          </View>
          <Text style={styles.name} numberOfLines={1}>
            {subSession.name}
          </Text>
        </PressHighlight>
        {allowDeletion && deletion.remove ? (
          <ToolbarButton
            label={t("workspaceSessionDeletion.menu")}
            onPress={deletion.remove}
            disabled={deletion.pending}
            testID={`sidebar-archived-sub-session-delete-${serverId}:${subSession.workspaceId}`}
          >
            <DensityIcon icon={Trash2} size="sm" color="foregroundMuted" />
          </ToolbarButton>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // One step in from the parent row, so the nesting reads at a glance while each sub-session
  // keeps the full workspace row: status, menu, and selection all behave as they do at the top.
  group: {
    paddingLeft: theme.spacing[4],
  },
  // Kept in step with the workspace row's geometry, like the Done toggle above it.
  toggleSlot: { flex: 1 },
  archivedRowContainer: { flexDirection: "row", alignItems: "center" },
  archivedRow: {
    flex: 1,
    minHeight: density.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  archivedRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  archivedRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  iconSlot: {
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  name: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
  },
}));
