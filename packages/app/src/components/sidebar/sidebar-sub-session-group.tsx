import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Archive } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { DensityIcon } from "@/components/ui/density-icon";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { density, densityIconBox } from "@/styles/density";
import { navigateToAgent } from "@/utils/navigate-to-agent";
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
}: {
  serverId: string;
  parentKey: string;
  parentName: string;
  subSessions: readonly SidebarWorkspacePlacement[];
  archivedSubSessions?: readonly ArchivedSubSession[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  renderRow: (placement: SidebarWorkspacePlacement) => ReactNode;
}) {
  const { t } = useTranslation();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const { active, done } = useMemo(
    () => groupSubSessionsByActivity({ children: subSessions, workspaceEntriesByKey }),
    [subSessions, workspaceEntriesByKey],
  );
  const toggleDone = useCallback(() => setDoneExpanded((expanded) => !expanded), []);
  const doneCount = done.length + archivedSubSessions.length;

  return (
    <View
      role="group"
      accessibilityLabel={t("sidebar.workspace.subSessions.group", { name: parentName })}
      style={styles.group}
      testID={`sidebar-sub-sessions-${parentKey}`}
    >
      {active.map((placement) => renderRow(placement))}
      {doneCount > 0 ? (
        <SidebarGroupToggleRow
          expanded={doneExpanded}
          onPress={toggleDone}
          label={t("sidebar.workspace.subSessions.done", { count: doneCount })}
          testID={`sidebar-sub-sessions-done-toggle-${parentKey}`}
        />
      ) : null}
      {doneExpanded ? (
        <View testID={`sidebar-sub-sessions-done-${parentKey}`}>
          {done.map((placement) => renderRow(placement))}
          {archivedSubSessions.map((subSession) => (
            <ArchivedSubSessionRow
              key={subSession.workspaceId}
              serverId={serverId}
              subSession={subSession}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A sub-session whose workspace was archived. Its agent's timeline survives the cleanup, so the
 * row opens that agent the way the Sessions list opens an archived agent; a workspace with no
 * agent opens on its own route, which offers recovery.
 */
function ArchivedSubSessionRow({
  serverId,
  subSession,
}: {
  serverId: string;
  subSession: ArchivedSubSession;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (subSession.agentId) {
      navigateToAgent({
        serverId,
        agentId: subSession.agentId,
        workspaceId: subSession.workspaceId,
        pin: true,
      });
      return;
    }
    navigateToWorkspace({ serverId, workspaceId: subSession.workspaceId });
  }, [serverId, subSession.agentId, subSession.workspaceId]);
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
    <PressHighlight
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={`${subSession.name}, ${archivedLabel}`}
      onPress={handlePress}
      style={rowStyle}
      testID={`sidebar-archived-sub-session-${serverId}:${subSession.workspaceId}`}
    >
      <View style={styles.iconSlot}>
        <DensityIcon icon={Archive} size="sm" color="foregroundMuted" />
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {subSession.name}
      </Text>
      <Text style={styles.archivedLabel} numberOfLines={1}>
        {archivedLabel}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  // One step in from the parent row, so the nesting reads at a glance while each sub-session
  // keeps the full workspace row: status, menu, and selection all behave as they do at the top.
  group: {
    paddingLeft: theme.spacing[4],
  },
  // Kept in step with the workspace row's geometry, like the Done toggle above it.
  archivedRow: {
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
  archivedLabel: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
}));
