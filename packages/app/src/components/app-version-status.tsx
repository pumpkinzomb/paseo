import { useMemo } from "react";
import { useLocalAppUpdate } from "@/hooks/use-local-app-update";
import type { Theme } from "@/styles/theme";
import { Text, View } from "react-native";
import { GitBranch } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
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
    />
  );
}

export function AppVersionStatus({
  version = resolveAppVersion(),
  update,
  productionReady = false,
  failure = null,
}: {
  version?: string | null;
  update?: LocalAppUpdate;
  productionReady?: boolean;
  failure?: "blocked" | "failed" | "recovery_required" | null;
}) {
  const { t } = useTranslation();
  if (!version) return null;
  return (
    <View style={styles.row} testID="sidebar-build-status">
      <Text
        style={styles.version}
        numberOfLines={1}
        accessibilityLabel={t("localAppUpdate.version", { version })}
        testID="app-version-label"
      >
        v{version}
      </Text>
      {failure && (
        <Text accessibilityRole="alert" testID="local-app-update-error" style={styles.failure}>
          {t(FAILURE_KEYS[failure])}
        </Text>
      )}
      {productionReady && update?.status === "verified" && update.releaseId.trim() && (
        <Button
          size="sm"
          variant="ghost"
          loading={update.pending}
          disabled={update.pending}
          onPress={update.onUpdateAndRestart}
          testID="local-app-update-restart"
        >
          {t(update.pending ? "localAppUpdate.updating" : "localAppUpdate.updateAndRestart")}
        </Button>
      )}
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
    flexBasis: "100%",
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  row: {
    minHeight: 32,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  version: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  buildBadge: { maxWidth: 160, overflow: "hidden", flexShrink: 1 },
}));
