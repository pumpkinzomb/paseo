import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { AssistantModelPriceLabel } from "./model-price-label";
import { AssistantHandoffSource } from "./handoff-source";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import { AssistantHandoffPreview } from "./handoff-preview";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import {
  assistantModelChangeKind,
  needsAssistantRuntimeMigration,
  assistantModelGroups,
  filterAssistantModelGroups,
  type AssistantModelSelection,
} from "./model-selection";

interface AssistantModelSwitch {
  serverId: string;
  select: (selection: AssistantModelSelection) => void;
}
const AssistantModelSwitchContext = createContext<AssistantModelSwitch | null>(null);

export function AssistantComposerModelSwitch({
  serverId,
  agentId,
  children,
}: {
  serverId: string;
  agentId: string;
  children: ReactNode;
}) {
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const changingModel = useRef(false);
  const { t } = useTranslation();
  const supportsHandoff = useHostFeature(serverId, "defaultAssistantContextHandoff");
  const [selection, setSelection] = useState<AssistantModelSelection | null>(null);
  const closePreview = useCallback(() => setSelection(null), []);
  const supported = useHostFeature(serverId, "defaultAssistantModelSelection");
  const isAssistant = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(agentId)?.labels?.["paseo.role"] === "assistant",
  );
  const needsMigration = useSessionStore((state) =>
    needsAssistantRuntimeMigration(state.sessions[serverId]?.agents.get(agentId)),
  );
  const select = useCallback(
    (next: AssistantModelSelection) => {
      if (changingModel.current) return;
      const source = useSessionStore.getState().sessions[serverId]?.agents.get(agentId);
      if (!source || !client) {
        toast.error(t("defaultAssistant.handoffDisconnected"));
        return;
      }
      if (
        source.status !== "idle" ||
        source.turn.phase === "open" ||
        source.pendingPermissions.length ||
        (source.backgroundWork?.count ?? 0) > 0
      ) {
        toast.error(t("defaultAssistant.handoffWaitIdle"));
        return;
      }
      if (
        assistantModelChangeKind(
          source.provider,
          next.provider,
          needsAssistantRuntimeMigration(source),
        ) === "in-place"
      ) {
        changingModel.current = true;
        void client
          .setAgentModel(agentId, next.model)
          .catch((error) => toast.error(toErrorMessage(error)))
          .finally(() => {
            changingModel.current = false;
          });
        return;
      }
      if (!supportsHandoff) {
        toast.error(t("defaultAssistant.updateHost"));
        return;
      }
      setSelection(next);
    },
    [agentId, client, serverId, supportsHandoff, t, toast],
  );
  const migrate = useCallback(() => {
    const source = useSessionStore.getState().sessions[serverId]?.agents.get(agentId);
    const model = source?.model ?? source?.runtimeInfo?.model;
    if (!source || !model) {
      toast.error(t("defaultAssistant.isolationChooseModel"));
      return;
    }
    select({ provider: source.provider, model });
  }, [agentId, serverId, select, t, toast]);
  const value = useMemo(
    () => (supported && isAssistant ? { serverId, select } : null),
    [supported, isAssistant, serverId, select],
  );
  return (
    <AssistantModelSwitchContext.Provider value={value}>
      <AssistantHandoffSource serverId={serverId} agentId={agentId} />
      {supported && supportsHandoff && needsMigration ? (
        <View testID="assistant-runtime-migration">
          <Text style={styles.notice}>{t("defaultAssistant.isolationNotice")}</Text>
          <Button variant="ghost" onPress={migrate} testID="assistant-runtime-migrate">
            {t("defaultAssistant.isolationAction")}
          </Button>
        </View>
      ) : null}
      {children}
      {selection ? (
        <AssistantHandoffPreview
          key={`${agentId}:${selection.provider}:${selection.model}`}
          serverId={serverId}
          sourceAgentId={agentId}
          selection={selection}
          purpose={needsMigration && selection.provider === "codex" ? "isolation" : undefined}
          onClose={closePreview}
        />
      ) : null}
    </AssistantModelSwitchContext.Provider>
  );
}

export function useAssistantModelSwitch() {
  return useContext(AssistantModelSwitchContext);
}

export function AssistantModelMenu({ onClose }: { onClose: () => void }) {
  const manager = useAssistantModelSwitch();
  if (!manager) return null;
  return <ConnectedAssistantModelMenu manager={manager} onClose={onClose} />;
}

function AssistantModelRow({
  model,
  provider,
  manager,
  onClose,
}: {
  model: AgentModelDefinition;
  provider: string;
  manager: AssistantModelSwitch;
  onClose: () => void;
}) {
  const select = useCallback(() => {
    onClose();
    manager.select({ provider, model: model.id });
  }, [manager, model.id, onClose, provider]);
  return (
    <PressHighlight
      onPress={select}
      style={styles.model}
      accessibilityRole="button"
      testID={`composer-assistant-model-${provider}-${model.id}`}
    >
      <Text style={styles.label}>{model.label}</Text>
      <Text style={styles.detail}>{model.id}</Text>
      <AssistantModelPriceLabel provider={provider} model={model} />
    </PressHighlight>
  );
}

function ConnectedAssistantModelMenu({
  manager,
  onClose,
}: {
  manager: AssistantModelSwitch;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const catalog = useProvidersSnapshot(manager.serverId);
  const [search, setSearch] = useState("");
  const groups = useMemo(
    () => filterAssistantModelGroups(assistantModelGroups(catalog.entries ?? []), search),
    [catalog.entries, search],
  );
  const { refresh: refreshCatalog } = catalog;
  const refresh = useCallback(() => {
    void refreshCatalog().catch(() => {});
  }, [refreshCatalog]);
  return (
    <View style={styles.container} testID="composer-assistant-model-menu">
      <Text style={styles.notice}>{t("defaultAssistant.managerModelNotice")}</Text>
      <Text style={styles.catalogNotice}>{t("defaultAssistant.modelShortlistNotice")}</Text>
      <TextInput
        initialValue=""
        onChangeText={setSearch}
        accessibilityLabel={t("defaultAssistant.searchModels")}
        placeholder={t("defaultAssistant.searchModels")}
        style={styles.search}
        testID="composer-assistant-model-search"
      />
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {groups.map((group) => (
          <View key={group.provider}>
            <Text style={styles.provider}>{group.label}</Text>
            {group.models.map((model) => (
              <AssistantModelRow
                key={model.id}
                model={model}
                provider={group.provider}
                manager={manager}
                onClose={onClose}
              />
            ))}
          </View>
        ))}
        {catalog.isLoading ? (
          <Text style={styles.detail}>{t("defaultAssistant.loadingModels")}</Text>
        ) : null}
        {!catalog.isLoading && !groups.length ? (
          <Text style={styles.detail}>{t("defaultAssistant.noModels")}</Text>
        ) : null}
        {catalog.error ? <Text style={styles.detail}>{catalog.error}</Text> : null}
        <Text style={styles.notice}>{t("defaultAssistant.modelAuthNotice")}</Text>
      </ScrollView>
      <Button variant="ghost" onPress={refresh} disabled={catalog.isFetching}>
        {t("defaultAssistant.refreshModels")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  search: {
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    margin: theme.spacing[2],
    padding: theme.spacing[2],
  },
  catalogNotice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
  },
  list: { flex: 1, minHeight: 0 },
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  provider: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
  },
  model: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[2] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
