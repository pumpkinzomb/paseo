import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Plus, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import { RetainedPanel } from "@/components/retained-panel";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { BrowserRecord } from "./store";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getDesktopHost } from "@/desktop/host";
import { BrowserPane } from "./pane";
import { createWorkspaceBrowser, useBrowserStore } from "./store";
import { useWorkspaceBrowserStore, removeWorkspaceBrowserPage } from "./workspace-store";
import type { BrowserWorkspaceContentProps } from "./workspace-content";

const PlusIcon = withUnistyles(Plus);
const CloseIcon = withUnistyles(X);
const iconColor = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

export function BrowserWorkspaceContent({
  serverId,
  workspaceId,
  cwd,
  active,
}: BrowserWorkspaceContentProps) {
  const { t } = useTranslation();
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const panel = useWorkspaceBrowserStore((state) =>
    workspaceKey ? state.panelsByWorkspace[workspaceKey] : undefined,
  );
  const browsers = useBrowserStore((state) => state.browsersById);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pages = useMemo(
    () =>
      (panel?.browserIds ?? [])
        .map((id) => browsers[id])
        .filter((browser) => browser !== undefined),
    [panel, browsers],
  );
  const selectedId =
    pages.find((page) => page.browserId === panel?.activeBrowserId)?.browserId ??
    pages[0]?.browserId;
  const rootId = `workspace-browser-${workspaceKey}`;
  const focusBrowser = useCallback(() => setFocused(true), []);

  useEffect(() => {
    if (!isWeb || typeof document === "undefined") return;
    function onFocus(event: FocusEvent) {
      const root = document.querySelector(`[data-testid=${JSON.stringify(rootId)}]`);
      const target = event.target;
      const guestFocused =
        target instanceof Element && target.getAttribute("data-paseo-browser-id") === selectedId;
      setFocused(guestFocused || (target instanceof Node && root?.contains(target) === true));
    }
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [rootId, selectedId]);

  useEffect(() => {
    const bridge = getDesktopHost()?.browser;
    const browserId = focused && active ? (selectedId ?? null) : null;
    void bridge
      ?.setWorkspaceActiveBrowser?.({ workspaceId, browserId })
      .catch((failure) => console.warn("Browser focus update failed", failure));
  }, [focused, active, selectedId, workspaceId]);

  const newPage = useCallback(() => {
    if (!workspaceKey) return;
    const { browserId } = createWorkspaceBrowser();
    useWorkspaceBrowserStore.getState().openPage(workspaceKey, browserId);
  }, [workspaceKey]);
  const closePage = useCallback(
    (browserId: string) => {
      if (!workspaceKey) return;
      setError(null);
      void removeWorkspaceBrowserPage({ workspaceKey, browserId }).catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      );
    },
    [workspaceKey],
  );
  if (!workspaceKey) return null;

  return (
    <View style={styles.dock} testID={rootId}>
      <View style={styles.pageTabs}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabList}
        >
          {pages.map((page) => (
            <BrowserPageTab
              key={page.browserId}
              page={page}
              selected={page.browserId === selectedId}
              workspaceKey={workspaceKey}
              onClose={closePage}
            />
          ))}
        </ScrollView>
        <ToolbarButton label={t("browserDock.newPage")} onPress={newPage}>
          <PlusIcon size={15} uniProps={iconColor} />
        </ToolbarButton>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.body}>
        {pages.map((page) => (
          <RetainedPanel key={page.browserId} active={active && page.browserId === selectedId}>
            <BrowserPane
              browserId={page.browserId}
              serverId={serverId}
              workspaceId={workspaceId}
              cwd={cwd}
              isInteractive={focused && active && page.browserId === selectedId}
              onFocusPane={focusBrowser}
            />
          </RetainedPanel>
        ))}
      </View>
    </View>
  );
}
function BrowserPageTab({
  page,
  selected,
  workspaceKey,
  onClose,
}: {
  page: BrowserRecord;
  selected: boolean;
  workspaceKey: string;
  onClose: (browserId: string) => void;
}) {
  const { t } = useTranslation();
  const state = useMemo(() => ({ selected }), [selected]);
  const select = useCallback(
    () => useWorkspaceBrowserStore.getState().selectPage(workspaceKey, page.browserId),
    [workspaceKey, page.browserId],
  );
  const close = useCallback(() => onClose(page.browserId), [onClose, page.browserId]);
  const title = page.title || page.url;
  return (
    <View style={[styles.tab, selected && styles.selectedTab]}>
      <PressHighlight
        accessibilityRole="tab"
        accessibilityState={state}
        accessibilityLabel={title}
        style={styles.tabLabel}
        onPress={select}
      >
        <Text numberOfLines={1} style={styles.tabText}>
          {title}
        </Text>
      </PressHighlight>
      <ToolbarButton compact label={t("browserDock.closePage", { title })} onPress={close}>
        <CloseIcon size={12} uniProps={iconColor} />
      </ToolbarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dock: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  pageTabs: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[1],
    minHeight: 36,
  },
  tabList: { alignItems: "center", gap: theme.spacing[1] },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 200,
    borderRadius: theme.borderRadius.sm,
  },
  selectedTab: { backgroundColor: theme.colors.surface2 },
  tabLabel: {
    flexShrink: 1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  tabText: { color: theme.colors.foreground, fontSize: 12 },
  body: { flex: 1, minHeight: 0 },
  error: { color: theme.colors.destructive, padding: theme.spacing[2], fontSize: 12 },
}));
