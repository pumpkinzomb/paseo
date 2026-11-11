import { Text, View } from "react-native";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { buildOpenProjectRoute, buildSettingsHostRoute } from "@/utils/host-routes";

export function WorkspaceRestoreRecoveryScreen({
  serverId,
  retry,
}: {
  serverId: string;
  retry: () => void;
}) {
  const { t } = useTranslation();
  const openHostSettings = useCallback(
    () => router.push(buildSettingsHostRoute(serverId)),
    [serverId],
  );
  const openProjects = useCallback(() => router.push(buildOpenProjectRoute()), []);
  return (
    <View testID="startup-workspace-recovery" style={styles.container}>
      <TitlebarDragRegion />
      <View style={styles.content}>
        <Text style={styles.title}>{t("startup.workspaceRestore.title")}</Text>
        <Text style={styles.description}>{t("startup.workspaceRestore.description")}</Text>
        <View style={styles.actions}>
          <Button onPress={retry}>{t("common.actions.retry")}</Button>
          <Button variant="outline" onPress={openHostSettings}>
            {t("startup.workspaceRestore.hostSettings")}
          </Button>
          <Button variant="ghost" onPress={openProjects}>
            {t("defaultAssistant.projects")}
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  description: { color: theme.colors.foregroundMuted, textAlign: "center", maxWidth: 480 },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
}));
