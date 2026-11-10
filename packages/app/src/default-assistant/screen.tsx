import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { MenuHeader } from "@/components/headers/menu-header";
import { useHostRuntimeSnapshot, getHostRuntimeStore } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildOpenProjectRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { createAssistantEntry } from "./entry";
import { navigateAssistantConversation } from "./conversation-navigation";

export function DefaultAssistantScreen({
  serverId,
  newSessionRequestId,
  provider,
  model,
}: {
  serverId: string;
  newSessionRequestId?: string;
  provider?: string;
  model?: string;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const runtime = useHostRuntimeSnapshot(serverId);
  const client = runtime?.client ?? null;
  const online = runtime?.connectionStatus === "online";
  const supported = useHostFeature(serverId, "defaultAssistant");
  const supportsModelSelection = useHostFeature(serverId, "defaultAssistantModelSelection");
  const requestedModelSelection = Boolean(provider || model);
  const canOpen = supported && (!requestedModelSelection || supportsModelSelection);
  const entry = useMemo(
    () =>
      createAssistantEntry({
        open: async () => {
          if (!client) throw new Error("Host client is unavailable");
          const result = await client.ensureDefaultAssistant({
            newSession: Boolean(newSessionRequestId),
            requestId: newSessionRequestId,
            provider,
            model,
          });
          if (result.error || !result.agent || !result.workspace) {
            throw new Error(result.error ?? "No assistant conversation was returned");
          }
          return {
            agentId: result.agent.id,
            workspaceId: result.workspace.id,
            conversation: result.conversation,
          };
        },
        navigate: ({ agentId, workspaceId, conversation }) => {
          if (conversation) navigateAssistantConversation({ serverId, conversation });
          else navigateToAgent({ serverId, agentId, workspaceId, pin: true });
        },
      }),
    [client, serverId, newSessionRequestId, provider, model],
  );
  const { mutate, isPending, error, reset } = useMutation({ mutationFn: () => entry.open() });

  useFocusEffect(
    useCallback(() => {
      reset();
      if (online && canOpen) mutate();
      return () => entry.cancel();
    }, [entry, online, canOpen, mutate, reset]),
  );

  const retry = useCallback(() => {
    if (online) mutate();
    else void getHostRuntimeStore().runProbeCycleNow(serverId);
  }, [online, mutate, serverId]);
  const openProviders = useCallback(
    () => router.push(buildSettingsHostSectionRoute(serverId, "providers")),
    [router, serverId],
  );
  const openProjects = useCallback(() => router.replace(buildOpenProjectRoute()), [router]);

  let description = t("defaultAssistant.connecting");
  if (online && !canOpen) description = t("defaultAssistant.updateHost");
  else if (online) description = t("defaultAssistant.opening");

  return (
    <View style={styles.container}>
      <MenuHeader title={t("defaultAssistant.title")} />
      <View style={styles.content} testID="default-assistant-entry">
        <Text style={styles.title}>{t("defaultAssistant.title")}</Text>
        <Text style={styles.description}>{description}</Text>
        {error ? (
          <Text style={styles.error} testID="default-assistant-error">
            {toErrorMessage(error)}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {error || !online ? (
            <Button onPress={retry} disabled={isPending}>
              {t("common.actions.retry")}
            </Button>
          ) : null}
          <Button variant="outline" onPress={openProviders}>
            {t("defaultAssistant.providers")}
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
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[4],
  },
  title: { color: theme.colors.foreground, fontSize: 20, fontWeight: "600" },
  description: { color: theme.colors.foregroundMuted, textAlign: "center" },
  error: { color: theme.colors.destructive, textAlign: "center" },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
}));
