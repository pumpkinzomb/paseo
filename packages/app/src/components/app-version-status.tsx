import { useMemo } from "react";
import { useLocalAppUpdate } from "@/hooks/use-local-app-update";
import type { Theme } from "@/styles/theme";
import { Text, View } from "react-native";
import { Download, GitBranch } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/ui/status-badge";
import { resolveAppVersion } from "@/utils/app-version";

const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedGitBranch = withUnistyles(GitBranch);
const FAILURE_KEYS = {
  blocked: "localAppUpdate.blocked",
  recovery_required: "localAppUpdate.recoveryRequired",
  failed: "localAppUpdate.failed",
} as const;
const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;

/** Only a trusted local controller may supply a verified candidate and its action.
 * No candidate is inferred from the package version or development label.
 * The production caller deliberately supplies no update until that bridge exists.
 */
export type LocalAppUpdate =
  | { status: "unavailable" }
  | {
      status: "verified";
      releaseId: string;
      pending?: boolean;
      retryable?: boolean;
      onUpdateAndRestart: () => void;
    };

export function ConnectedAppVersionStatus() {
  const bridge = useLocalAppUpdate();
  return (
    <AppVersionStatus
      version={bridge.version}
      update={bridge.update}
      productionReady={bridge.ready}
      failure={bridge.failure}
      failureReason={bridge.failureReason}
    />
  );
}

export function AppVersionStatus({
  version = resolveAppVersion(),
  update,
  productionReady = false,
  failure = null,
  failureReason,
}: {
  version?: string | null;
  update?: LocalAppUpdate;
  productionReady?: boolean;
  failure?: "blocked" | "failed" | "recovery_required" | null;
  failureReason?: "transport_mismatch" | null;
}) {
  const { t } = useTranslation();
  if (!version) return null;
  const canUpdate =
    productionReady &&
    update?.status === "verified" &&
    update.releaseId.trim() &&
    (!failure || (failure === "blocked" && update.retryable === true));
  return (
    <View style={styles.row} testID="sidebar-build-status">
      <View style={styles.mainRow} testID="app-version-action-row">
        <Text
          style={styles.version}
          numberOfLines={1}
          accessibilityLabel={t("localAppUpdate.version", { version })}
          testID="app-version-label"
        >
          v{version}
        </Text>
        {canUpdate && update?.status === "verified" ? (
          <UpdateAction update={update} retry={failure === "blocked"} />
        ) : null}
      </View>
      {failure ? (
        <Text accessibilityRole="alert" testID="local-app-update-error" style={styles.failure}>
          {t(
            failure === "blocked" && failureReason === "transport_mismatch"
              ? "localAppUpdate.transportMismatch"
              : FAILURE_KEYS[failure],
          )}
        </Text>
      ) : null}
    </View>
  );
}

function UpdateAction({
  update,
  retry,
}: {
  update: Extract<LocalAppUpdate, { status: "verified" }>;
  retry: boolean;
}) {
  const { t } = useTranslation();
  const hint = t(retry ? "localAppUpdate.retryHint" : "localAppUpdate.restartHint");
  let label = t("localAppUpdate.update");
  if (retry) label = t("common.actions.retry");
  if (update.pending) label = t("localAppUpdate.updating");
  return (
    <View style={styles.action}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={Download}
            loading={update.pending}
            disabled={update.pending}
            onPress={update.onUpdateAndRestart}
            accessibilityLabel={update.pending ? label : hint}
            testID="local-app-update-restart"
          >
            {label}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <Text style={styles.hint}>{hint}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

/** This label describes the build, not the selected workspace's Git branch. */
export function DevelopmentBuildBadge({ label = DEV_BUILD_LABEL }: { label?: string | null }) {
  const { t } = useTranslation();
  const leading = useMemo(
    () => <ThemedGitBranch size={12} uniProps={foregroundMutedIconColorMapping} />,
    [],
  );
  if (!label?.trim()) return null;
  return (
    <View
      pointerEvents="none"
      style={styles.buildBadge}
      testID="dev-build-label"
      accessibilityLabel={t("localAppUpdate.developmentBuild", { label })}
    >
      <StatusBadge label={label} size="xs" leading={leading} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  failure: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  row: {
    minHeight: 32,
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[0.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  mainRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
  },
  action: { flexShrink: 0 },
  hint: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  version: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  buildBadge: { maxWidth: 160, overflow: "hidden", flexShrink: 1 },
}));
