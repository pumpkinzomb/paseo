import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { Button } from "@/components/ui/button";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import {
  useHosts,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildSessionsRoute } from "@/utils/host-routes";
import { confirmDialog } from "@/utils/confirm-dialog";

function closeInlineList() {}

export function LocalSessionsScreen() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const lastSelection = useLastWorkspaceSelection();
  const [chosenHost, setChosenHost] = useState<string | null>(null);
  const preferredHost = chosenHost ?? lastSelection?.serverId;
  const host = hosts.find((candidate) => candidate.serverId === preferredHost) ?? hosts[0];
  const router = useRouter();
  const openHistory = useCallback(() => router.push(buildSessionsRoute()), [router]);
  const historyButton = useMemo(
    () => (
      <Button variant="ghost" onPress={openHistory}>
        {t("localSessions.history")}
      </Button>
    ),
    [openHistory, t],
  );
  return (
    <View style={styles.container}>
      <MenuHeader title={t("localSessions.title")} rightContent={historyButton} />
      <View style={styles.intro}>
        <Text style={styles.description}>{t("localSessions.description")}</Text>
        {hosts.length > 1 && host ? (
          <HostFilter
            hosts={hosts}
            selectedHost={host.serverId}
            onSelectHost={setChosenHost}
            includeAllHost={false}
          />
        ) : null}
      </View>
      {host ? (
        <HostLocalSessions key={host.serverId} serverId={host.serverId} />
      ) : (
        <Text style={styles.description}>{t("importSession.status.connectHost")}</Text>
      )}
    </View>
  );
}

function HostLocalSessions({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);
  const supported = useHostFeature(serverId, "localProviderSessions");
  const focused = useIsFocused();
  const active = useRef(false);
  useEffect(() => {
    active.current = focused;
    return () => {
      active.current = false;
    };
  }, [focused]);
  const confirmIdle = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("localSessions.confirmTitle"),
      message: t("localSessions.confirmBody"),
      confirmLabel: t("localSessions.confirmIdle"),
      cancelLabel: t("common.actions.cancel"),
    });
    return confirmed && active.current;
  }, [t]);
  const openLinkedAgent = useCallback(
    (agentId: string) => {
      if (active.current) navigateToAgent({ serverId, agentId, pin: true });
    },
    [serverId],
  );
  const openImported = useCallback(
    (agent: { id: string; workspaceId?: string }) => {
      if (active.current)
        navigateToAgent({ serverId, agentId: agent.id, workspaceId: agent.workspaceId, pin: true });
    },
    [serverId],
  );
  if (connectionStatus !== "online")
    return <Text style={styles.description}>{t("importSession.status.connectHost")}</Text>;
  if (!supported) return <Text style={styles.description}>{t("localSessions.updateHost")}</Text>;
  return (
    <ImportSessionSheet
      presentation="page"
      visible={focused}
      includeImported
      client={client}
      serverId={serverId}
      onClose={closeInlineList}
      confirmExternalIdle={confirmIdle}
      onOpenLinkedAgent={openLinkedAgent}
      onImported={openImported}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  intro: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    gap: theme.spacing[3],
  },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
