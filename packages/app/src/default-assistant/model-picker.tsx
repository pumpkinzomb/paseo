import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { AssistantModelPriceLabel } from "./model-price-label";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { toErrorMessage } from "@/utils/error-messages";
import {
  assistantModelGroups,
  filterAssistantModelGroups,
  type AssistantModelSelection,
} from "./model-selection";

interface AssistantModelPickerProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  onSelect: (selection: AssistantModelSelection) => void;
}

export function AssistantModelPicker(props: AssistantModelPickerProps) {
  if (!props.visible) return null;
  return <OpenAssistantModelPicker key={props.serverId} {...props} />;
}

function ModelChoice({
  provider,
  model,
  selected,
  onSelect,
}: {
  provider: string;
  model: AgentModelDefinition;
  selected: boolean;
  onSelect: (selection: AssistantModelSelection) => void;
}) {
  const { t } = useTranslation();
  const select = useCallback(
    () => onSelect({ provider, model: model.id }),
    [model.id, onSelect, provider],
  );
  const style = useMemo(() => [styles.choice, selected && styles.selected], [selected]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      style={style}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={select}
      testID={`assistant-model-${provider}-${model.id}`}
    >
      <View style={styles.choiceText}>
        <Text style={styles.label}>{model.label}</Text>
        <Text style={styles.modelId}>{model.id}</Text>
        <AssistantModelPriceLabel provider={provider} model={model} />
      </View>
      {model.isDefault ? (
        <Text style={styles.hint}>{t("defaultAssistant.providerDefault")}</Text>
      ) : null}
      {selected ? <Text style={styles.label}>✓</Text> : null}
    </PressHighlight>
  );
}

function OpenAssistantModelPicker({ serverId, onClose, onSelect }: AssistantModelPickerProps) {
  const { t } = useTranslation();
  const catalog = useProvidersSnapshot(serverId);
  const groups = useMemo(() => assistantModelGroups(catalog.entries ?? []), [catalog.entries]);
  const [search, setSearch] = useState("");
  const shownGroups = useMemo(() => filterAssistantModelGroups(groups, search), [groups, search]);
  const [selected, setSelected] = useState<AssistantModelSelection | null>(null);
  const refreshMutation = useMutation({ mutationFn: () => catalog.refresh() });
  const { mutate: refreshCatalog } = refreshMutation;
  const refresh = useCallback(() => refreshCatalog(), [refreshCatalog]);
  const selectedAvailable = groups.some(
    (group) =>
      group.provider === selected?.provider &&
      group.models.some((model) => model.id === selected.model),
  );
  const submit = useCallback(() => {
    if (selected && selectedAvailable) onSelect(selected);
  }, [onSelect, selected, selectedAvailable]);
  const header = useMemo(
    () => ({
      title: t("defaultAssistant.chooseModel"),
      subtitle: <Text style={styles.notice}>{t("defaultAssistant.modelSelectionNotice")}</Text>,
    }),
    [t],
  );
  const error = refreshMutation.error ?? catalog.error;
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      desktopMaxWidth={620}
      testID="assistant-model-picker"
    >
      <Text style={styles.explanation}>{t("defaultAssistant.modelShortlistNotice")}</Text>
      {catalog.isLoading ? (
        <Text style={styles.explanation}>{t("defaultAssistant.loadingModels")}</Text>
      ) : null}
      {error ? <Text style={styles.error}>{toErrorMessage(error)}</Text> : null}
      {!catalog.isLoading && groups.length === 0 ? (
        <Text style={styles.explanation}>{t("defaultAssistant.noModels")}</Text>
      ) : null}
      <TextInput
        initialValue=""
        onChangeText={setSearch}
        accessibilityLabel={t("defaultAssistant.searchModels")}
        placeholder={t("defaultAssistant.searchModels")}
        style={styles.search}
        testID="assistant-model-search"
      />
      {shownGroups.map((group) => (
        <SettingsSection title={group.label} key={group.provider}>
          <View style={styles.choices}>
            {group.models.map((model) => (
              <ModelChoice
                key={model.id}
                provider={group.provider}
                model={model}
                selected={selected?.provider === group.provider && selected.model === model.id}
                onSelect={setSelected}
              />
            ))}
          </View>
        </SettingsSection>
      ))}
      <Text style={styles.explanation}>{t("defaultAssistant.modelAuthNotice")}</Text>
      <View style={styles.actions}>
        <Button
          variant="ghost"
          leftIcon={RotateCw}
          onPress={refresh}
          disabled={refreshMutation.isPending || catalog.isFetching}
        >
          {t("defaultAssistant.refreshModels")}
        </Button>
        <Button variant="outline" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button onPress={submit} disabled={!selectedAvailable} testID="assistant-model-start">
          {t("defaultAssistant.startWithModel")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  search: {
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[3],
  },
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  explanation: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[4],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[4],
  },
  choices: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  selected: { backgroundColor: theme.colors.surface1 },
  choiceText: { flex: 1 },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  modelId: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
