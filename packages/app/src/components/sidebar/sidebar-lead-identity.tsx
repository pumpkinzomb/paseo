import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useFetchQuery } from "@/data/query";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useIsCompactFormFactor } from "@/constants/layout";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openLeadIdentityForm } from "./lead-identity-form-model";

export function SidebarLeadIdentitySheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose(): void;
}) {
  return visible ? <IdentityHostSelector onClose={onClose} /> : null;
}
function IdentityHostSelector({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const [selected, setSelected] = useState<string | null>(() =>
    hosts.length === 1 ? hosts[0].serverId : null,
  );
  const header = useMemo(() => ({ title: t("leadIdentity.title") }), [t]);
  if (selected)
    return (
      <HostIdentity
        key={selected}
        serverId={selected}
        name={hosts.find((h) => h.serverId === selected)?.label || selected}
        onClose={onClose}
      />
    );
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="lead-identity-hosts">
      <View style={styles.content}>
        <Text style={styles.detail}>
          {t(hosts.length ? "leadIdentity.chooseHost" : "leadIdentity.noHosts")}
        </Text>
        {hosts.map((host) => (
          <IdentityHostButton
            key={host.serverId}
            serverId={host.serverId}
            label={host.label || host.serverId}
            onSelect={setSelected}
          />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}
function IdentityHostButton({
  serverId,
  label,
  onSelect,
}: {
  serverId: string;
  label: string;
  onSelect(id: string): void;
}) {
  const select = useCallback(() => onSelect(serverId), [onSelect, serverId]);
  return (
    <Button variant="outline" onPress={select}>
      {label}
    </Button>
  );
}
function HostIdentity({
  serverId,
  name,
  onClose,
}: {
  serverId: string;
  name: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "leadIdentitySettings");
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["lead-identity", serverId],
    enabled: connected && supported && Boolean(client),
    queryFn: async () => {
      if (!client) throw new Error("offline");
      return (await client.getDaemonConfig()).config;
    },
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
  });
  const header = useMemo(
    () => ({
      title: t("leadIdentity.title"),
      subtitle: <Text style={styles.detail}>{name}</Text>,
    }),
    [t, name],
  );
  const persist = useCallback(
    async (text: string, previous: string) => {
      if (!connected || !client) throw new Error("offline");
      const latest = (await client.getDaemonConfig()).config;
      if (latest.leadPersona !== previous) throw new Error("conflict");
      const result = await client.patchDaemonConfig({ leadPersona: text });
      if (result.config.leadPersona === undefined) throw new Error("missing response");
      return result.config.leadPersona;
    },
    [client, connected],
  );
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (query.isFetchedAfterMount && query.data?.leadPersona !== undefined) {
    return (
      <IdentityEditor
        initial={query.data.leadPersona}
        name={name}
        connected={connected}
        onClose={onClose}
        persist={persist}
      />
    );
  }
  let message = "leadIdentity.loading";
  if (!connected) message = "leadIdentity.offline";
  else if (!supported) message = "leadIdentity.unsupported";
  else if (query.isError) message = "leadIdentity.failed";
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="lead-identity-loading">
      <View style={styles.content}>
        <Text style={styles.detail}>{t(message)}</Text>
        {query.isError && connected && supported ? (
          <Button variant="outline" onPress={retry}>
            {t("leadIdentity.retry")}
          </Button>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}
function IdentityEditor({
  initial,
  name,
  connected,
  persist,
  onClose,
}: {
  initial: string;
  name: string;
  connected: boolean;
  persist(text: string, previous: string): Promise<string>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [model] = useState(() => openLeadIdentityForm(initial));
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const dirty = state.text !== state.saved;
  const close = useCallback(async () => {
    if (state.saving) return;
    if (
      !dirty ||
      (await confirmDialog({
        title: t("leadIdentity.discardTitle"),
        message: t("leadIdentity.discard"),
        confirmLabel: t("leadIdentity.discardAction"),
        cancelLabel: t("leadIdentity.cancel"),
      }))
    )
      onClose();
  }, [state.saving, dirty, t, onClose]);
  const reset = useCallback(async () => {
    if (
      await confirmDialog({
        title: t("leadIdentity.reset"),
        message: t("leadIdentity.resetConfirm"),
        confirmLabel: t("leadIdentity.reset"),
        cancelLabel: t("leadIdentity.cancel"),
      })
    )
      await model.save(persist, true);
  }, [t, model, persist]);
  const save = useCallback(() => {
    void model.save(persist);
  }, [model, persist]);
  const header = useMemo(
    () => ({
      title: t("leadIdentity.title"),
      subtitle: <Text style={styles.detail}>{name}</Text>,
    }),
    [t, name],
  );
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          variant="outline"
          disabled={state.saving || !connected}
          onPress={reset}
          testID="lead-identity-reset"
        >
          {t("leadIdentity.reset")}
        </Button>
        <Button
          disabled={
            state.saving || !connected || !dirty || !state.text.trim() || state.text.length > 12000
          }
          onPress={save}
          testID="lead-identity-save"
        >
          {t(state.saving ? "leadIdentity.saving" : "leadIdentity.save")}
        </Button>
      </View>
    ),
    [state.saving, state.text, connected, dirty, reset, save, t],
  );
  let notice = "leadIdentity.application";
  if (!connected) notice = "leadIdentity.offline";
  else if (state.savedNotice) notice = "leadIdentity.saved";
  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={header}
      desktopMaxWidth={680}
      testID="lead-identity-editor"
      footer={footer}
    >
      <View style={styles.content}>
        <Text style={styles.detail}>{t("leadIdentity.scope")}</Text>
        <Field
          label={t("leadIdentity.persona")}
          error={state.error ? t(`leadIdentity.${state.error}`) : null}
        >
          <FormTextInput
            initialValue={state.text}
            resetKey={state.resetKey}
            onChangeText={model.setText}
            multiline
            editable={!state.saving}
            size={compact ? "md" : "sm"}
            style={styles.editor}
            testID="lead-identity-text"
            accessibilityLabel={t("leadIdentity.persona")}
          />
        </Field>
        <Text style={styles.detail}>{t(notice)}</Text>
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[3] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  editor: { minHeight: 280, textAlignVertical: "top" },
  actions: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[2] },
}));
