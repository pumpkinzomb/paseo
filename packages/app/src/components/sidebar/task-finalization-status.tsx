import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceTaskFinalization } from "@getpaseo/protocol/messages";

export function TaskFinalizationStatus({ task }: { task: WorkspaceTaskFinalization | undefined }) {
  const { t } = useTranslation();
  if (!task || task.phase === "retired") return null;
  let key = "sidebar.workspace.subSessions.finalizationPending";
  if (task.phase === "blocked") key = "sidebar.workspace.subSessions.finalizationBlocked";
  if (task.phase === "invalidated") key = "sidebar.workspace.subSessions.finalizationInvalidated";
  const message = task.reason ? `${t(key)}: ${task.reason}` : t(key);
  return (
    <Text
      testID={`task-finalization-${task.workspaceId}`}
      accessibilityLabel={message}
      numberOfLines={2}
      style={styles.status}
    >
      {message}
    </Text>
  );
}
const styles = StyleSheet.create((theme) => ({
  status: { color: theme.colors.foregroundMuted, fontSize: 11 },
}));
