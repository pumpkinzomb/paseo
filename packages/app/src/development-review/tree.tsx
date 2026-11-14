import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { usePaneContext } from "@/panels/pane-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  TreeChevron,
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
} from "@/components/tree-primitives";
import { MaterialFileIcon } from "@/components/material-file-icon";
import {
  developmentReviewIdentityKey,
  type DevelopmentReviewIdentity,
} from "@/workspace/file-open";
import type { DevelopmentReviewScope } from "@getpaseo/protocol/messages";
import { useDevelopmentReviewSelection } from "./selection";
import { developmentScopeIdentity, useDevelopmentSelection } from "./pane";

function useTreeHost() {
  const { serverId, workspaceId } = usePaneContext();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const active = useRetainedPanelActive();
  const visible = useAppActivelyVisible();
  const supported = client?.getLastServerInfoMessage()?.features?.developmentReview === true;
  return {
    serverId,
    workspaceId,
    client,
    enabled: [connected, active, visible, supported].every(Boolean),
  };
}
function TreeRow({
  label,
  detail,
  depth,
  expanded,
  selected,
  onPress,
  onFocus,
}: {
  label: string;
  detail?: string;
  depth: number;
  expanded?: boolean;
  selected?: boolean;
  onPress: () => void;
  onFocus: () => void;
}) {
  const style = useMemo(
    () => [
      workspaceTreeRowStyles.row,
      selected && workspaceTreeRowStyles.active,
      { paddingLeft: treeRowPaddingLeft(depth) },
    ],
    [depth, selected],
  );
  const accessibilityState = useMemo(() => ({ expanded, selected }), [expanded, selected]);
  return (
    <PressHighlight
      testID="file-explorer-row-development"
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityState={accessibilityState}
      onPress={onPress}
      onFocus={onFocus}
      style={style}
    >
      {expanded === undefined ? (
        <MaterialFileIcon fileName={label} size={16} />
      ) : (
        <TreeChevron expanded={expanded} />
      )}
      <View style={styles.labels}>
        <Text style={workspaceTreeRowStyles.name}>{label}</Text>
        {detail && <Text style={styles.detail}>{detail}</Text>}
      </View>
    </PressHighlight>
  );
}
export function ConversationTreeGroup({
  path,
  expanded,
  onPress,
  onFocus,
}: {
  path: string;
  expanded: boolean;
  onPress: () => void;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TreeRow
      label={t("developmentReview.conversation")}
      detail={path}
      depth={0}
      expanded={expanded}
      onPress={onPress}
      onFocus={onFocus}
    />
  );
}
export function DevelopmentTreeGroups() {
  const { t } = useTranslation();
  const { serverId, workspaceId, client, enabled } = useTreeHost();
  const query = useFetchQuery({
    queryKey: ["development-scopes", serverId, workspaceId],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: () => client!.readDevelopmentReview({ workspaceId, operation: "list" }),
    enabled,
    refetchInterval: enabled ? 10000 : false,
    refetchIntervalInBackground: false,
  });
  return (
    <View>
      {query.error && <Text style={styles.detail}>{String(query.error)}</Text>}
      {query.data?.scopes.map((scope) => (
        <DevelopmentTreeGroup
          key={`${serverId}:${workspaceId}:${scope.workspaceId}:${scope.evidenceId ?? "live"}`}
          scope={scope}
        />
      ))}
      {query.isPending && <Text style={styles.detail}>{t("workspace.tabs.loading")}</Text>}
    </View>
  );
}
function DevelopmentTreeGroup({ scope }: { scope: DevelopmentReviewScope }) {
  const { serverId, workspaceId } = usePaneContext();
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const identity = useMemo(
    () => developmentScopeIdentity(serverId, workspaceId, scope),
    [serverId, workspaceId, scope],
  );
  const selected = useDevelopmentSelection(serverId, workspaceId);
  const select = useDevelopmentReviewSelection((state) => state.select);
  const focus = useCallback(
    () => select(JSON.stringify([serverId, workspaceId]), identity),
    [select, serverId, workspaceId, identity],
  );
  const toggle = useCallback(() => {
    focus();
    setExpanded((value) => !value);
  }, [focus]);
  const detail = `${scope.path} · ${scope.branch ?? ""} · ${t(`developmentReview.${scope.status}`)} ${scope.headSha?.slice(0, 8) ?? ""}`;
  return (
    <View>
      <TreeRow
        label={scope.label}
        detail={detail}
        depth={0}
        expanded={expanded}
        selected={developmentReviewIdentityKey(selected) === developmentReviewIdentityKey(identity)}
        onPress={toggle}
        onFocus={focus}
      />
      {expanded && <ReviewDirectory selected={identity} path="" depth={1} />}
    </View>
  );
}
function ReviewDirectory({
  selected,
  path,
  depth,
}: {
  selected: DevelopmentReviewIdentity;
  path: string;
  depth: number;
}) {
  const { serverId, workspaceId, client, enabled } = useTreeHost();
  const query = useFetchQuery({
    queryKey: ["development-tree", serverId, workspaceId, selected, path],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: () =>
      client!.readDevelopmentReview({
        workspaceId,
        scopeWorkspaceId: selected.workspaceId,
        scopeToken: selected.scopeToken,
        evidenceId: selected.evidenceId,
        operation: "files",
        path,
      }),
    enabled,
    refetchInterval: !selected.evidenceId && enabled ? 5000 : false,
    refetchIntervalInBackground: false,
  });
  return (
    <View>
      {query.error && <Text style={styles.detail}>{String(query.error)}</Text>}
      {query.data?.entries?.map((entry) => (
        <ReviewEntry key={entry.path} selected={selected} entry={entry} depth={depth} />
      ))}
    </View>
  );
}
function ReviewEntry({
  selected,
  entry,
  depth,
}: {
  selected: DevelopmentReviewIdentity;
  entry: { path: string; name: string; kind: "file" | "directory" };
  depth: number;
}) {
  const { serverId, workspaceId, openPreferredTarget } = usePaneContext();
  const [expanded, setExpanded] = useState(false);
  const select = useDevelopmentReviewSelection((state) => state.select);
  const focus = useCallback(
    () => select(JSON.stringify([serverId, workspaceId]), selected),
    [select, serverId, workspaceId, selected],
  );
  const press = useCallback(() => {
    focus();
    if (entry.kind === "directory") setExpanded((value) => !value);
    else
      openPreferredTarget(
        { kind: "file", path: entry.path, developmentReview: selected },
        "explorerFiles",
      );
  }, [focus, entry, openPreferredTarget, selected]);
  return (
    <View>
      <TreeRow
        label={entry.name}
        depth={depth}
        expanded={entry.kind === "directory" ? expanded : undefined}
        onPress={press}
        onFocus={focus}
      />
      {expanded && <ReviewDirectory selected={selected} path={entry.path} depth={depth + 1} />}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  labels: { flex: 1, marginLeft: theme.spacing[2] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
