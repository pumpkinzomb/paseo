import { developmentReviewIdentityKey } from "@/workspace/file-open";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useDevelopmentReviewSelection as useSelection } from "./selection";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useHostRuntimeIsConnected, useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePaneContext } from "@/panels/pane-context";
import { FileSourceView } from "@/file-panels/source/readonly/view";
import { sourceAppearance } from "@/file-panels/source/appearance";
import { DiffDocument } from "@/git/diff-document";
import { useAppSettings } from "@/hooks/use-settings";
import type { DevelopmentReviewIdentity } from "@/workspace/file-open";
import type { DevelopmentReviewScope, DevelopmentReviewData } from "@getpaseo/protocol/messages";

const SourceView = withUnistyles(FileSourceView, sourceAppearance);
export const developmentScopeIdentity = (
  serverId: string,
  parentWorkspaceId: string,
  scope: DevelopmentReviewScope,
): DevelopmentReviewIdentity => ({
  serverId,
  parentWorkspaceId,
  workspaceId: scope.workspaceId,
  ...(scope.scopeToken ? { scopeToken: scope.scopeToken } : {}),
  ...(scope.evidenceId ? { evidenceId: scope.evidenceId } : {}),
});
const scopeKey = developmentReviewIdentityKey;
export function useDevelopmentSelection(serverId: string, workspaceId: string) {
  return useSelection((state) => state.values[JSON.stringify([serverId, workspaceId])]);
}
interface FileExplorerEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
}
function Action<T>({
  label,
  onPress,
  value,
}: {
  label: string;
  onPress: (value: T) => void;
  value: T;
}) {
  const press = useCallback(() => onPress(value), [onPress, value]);
  return (
    <Button variant="ghost" accessibilityLabel={label} onPress={press}>
      {label}
    </Button>
  );
}
export function FollowingDevelopmentChanges({
  conversation,
}: {
  conversation: import("react").ReactNode;
}) {
  const { serverId, workspaceId } = usePaneContext();
  const selected = useDevelopmentSelection(serverId, workspaceId);
  const client = useHostRuntimeClient(serverId);
  if (!selected || client?.getLastServerInfoMessage()?.features?.developmentReview !== true)
    return conversation;
  return (
    <DevelopmentReviewPane
      key={developmentReviewIdentityKey(selected)}
      selected={selected}
      mode="diff"
    />
  );
}
export function DevelopmentReviewPane({
  selected,
  mode,
  filePath = "",
}: {
  selected: DevelopmentReviewIdentity;
  mode: "files" | "file" | "diff";
  filePath?: string;
}) {
  const { serverId, workspaceId, openPreferredTarget } = usePaneContext();
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState("");
  const active = useRetainedPanelActive();
  const visible = useAppActivelyVisible();
  const connected = useHostRuntimeIsConnected(serverId);
  const correctHost = selected.serverId === serverId && selected.parentWorkspaceId === workspaceId;
  const supported = client?.getLastServerInfoMessage()?.features?.developmentReview === true;
  const enabled = [correctHost, supported, connected, active, visible].every(Boolean);
  const query = useFetchQuery({
    queryKey: ["development-read", serverId, workspaceId, selected, mode, filePath, directory],
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: () =>
      client!.readDevelopmentReview({
        workspaceId,
        scopeWorkspaceId: selected.workspaceId,
        scopeToken: selected.scopeToken,
        evidenceId: selected.evidenceId,
        operation: mode,
        path: mode === "file" ? filePath : directory,
      }),
    enabled,
    refetchInterval: !selected.evidenceId && enabled ? 5000 : false,
    refetchIntervalInBackground: false,
  });
  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);
  const back = useCallback(
    () => setDirectory(directory.split("/").slice(0, -1).join("/")),
    [directory],
  );
  const openFile = useCallback(
    (path: string) =>
      openPreferredTarget({ kind: "file", path, developmentReview: selected }, "explorerFiles"),
    [openPreferredTarget, selected],
  );
  const openEntry = useCallback(
    (entry: FileExplorerEntry) => {
      if (entry.kind === "directory") setDirectory(entry.path);
      else openFile(entry.path);
    },
    [openFile],
  );
  const scope = query.data?.scopes.find(
    (entry) =>
      scopeKey(developmentScopeIdentity(serverId, workspaceId, entry)) === scopeKey(selected),
  );
  const capture = useCallback(async () => {
    if (!scope) return;
    try {
      await client!.captureDevelopmentReview(
        workspaceId,
        scope.workspaceId,
        scope.sourceWorkspaceId,
      );
      await queryClient.invalidateQueries({
        queryKey: ["development-scopes", serverId, workspaceId],
      });
      setError("");
    } catch (failure) {
      setError(String(failure));
    }
  }, [scope, client, workspaceId, queryClient, serverId]);
  const displayPreferences = useMemo(
    () => ({
      layout: "unified" as const,
      wrapLines: true,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [settings.codeFontSize, settings.monoFontFamily],
  );
  const diffMode = useMemo(() => ({ kind: "working" as const, onOpenFile: openFile }), [openFile]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const collapseState = useMemo(() => ({ paths: collapsed, onChange: setCollapsed }), [collapsed]);
  const location = useMemo(() => ({ path: filePath }), [filePath]);
  if (!correctHost) return <Text style={styles.detail}>{t("developmentReview.unavailable")}</Text>;
  if (!supported) return <Text style={styles.detail}>{t("developmentReview.update")}</Text>;
  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.detail}>{t("developmentReview.readonly")}</Text>
        <Button variant="ghost" onPress={refresh}>
          {t("developmentReview.refresh")}
        </Button>
      </View>
      <ReviewScopeCaption scope={scope} />
      {mode === "diff" &&
        !selected.evidenceId &&
        scope &&
        scope.workspaceId !== scope.sourceWorkspaceId && (
          <Button variant="outline" onPress={capture}>
            {t("developmentReview.capture")}
          </Button>
        )}
      {error && <Text style={styles.detail}>{error}</Text>}
      <ReviewContent
        error={query.error}
        data={query.data}
        loading={query.isPending}
        mode={mode}
        directory={directory}
        back={back}
        openEntry={openEntry}
        filePath={filePath}
        location={location}
        diffMode={diffMode}
        collapseState={collapseState}
        displayPreferences={displayPreferences}
      />
    </View>
  );
}
function ReviewScopeCaption({ scope }: { scope?: DevelopmentReviewScope }) {
  const { t } = useTranslation();
  if (!scope) return null;
  return (
    <Text style={styles.detail}>
      {scope.label} · {scope.path} · {scope.branch} · {t(`developmentReview.${scope.status}`)}{" "}
      {scope.headSha?.slice(0, 8)}
    </Text>
  );
}
function ReviewContent({
  error,
  data,
  loading,
  mode,
  directory,
  back,
  openEntry,
  filePath,
  location,
  diffMode,
  collapseState,
  displayPreferences,
}: {
  error: Error | null;
  data?: DevelopmentReviewData;
  loading: boolean;
  mode: "files" | "file" | "diff";
  directory: string;
  back: () => void;
  openEntry: (entry: FileExplorerEntry) => void;
  filePath: string;
  location: { path: string };
  diffMode: { kind: "working"; onOpenFile: (path: string) => void };
  collapseState: { paths: string[]; onChange: (paths: string[]) => void };
  displayPreferences: {
    layout: "unified";
    wrapLines: boolean;
    codeFontSize: number;
    monoFontFamily: string;
  };
}) {
  const { t } = useTranslation();
  if (error) return <Text style={styles.detail}>{String(error)}</Text>;
  if (mode === "files")
    return (
      <ScrollView style={styles.container}>
        {!!directory && (
          <Button variant="ghost" onPress={back}>
            {t("developmentReview.back")}
          </Button>
        )}
        {data?.entries?.map((entry) => (
          <Action
            key={entry.path}
            value={entry}
            label={`${entry.kind === "directory" ? "▸ " : ""}${entry.name}`}
            onPress={openEntry}
          />
        ))}
      </ScrollView>
    );
  if (loading) return <Text style={styles.detail}>…</Text>;
  if (mode === "file")
    return (
      <SourceView
        content={data?.content ?? ""}
        filename={filePath}
        location={location}
        navigationRevision={0}
        presentation="highlighted"
      />
    );
  if (data?.files?.length)
    return (
      <DiffDocument
        files={data.files}
        mode={diffMode}
        collapseState={collapseState}
        displayPreferences={displayPreferences}
      />
    );
  return <Text style={styles.detail}>{t("developmentReview.empty")}</Text>;
}
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  detail: { color: theme.colors.foregroundMuted, padding: theme.spacing[2] },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
}));
