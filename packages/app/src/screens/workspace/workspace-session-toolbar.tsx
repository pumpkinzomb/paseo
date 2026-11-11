import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";

export function WorkspaceSessionToolbar({
  onNewSession,
  disabled,
}: {
  onNewSession: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.row} testID="workspace-session-toolbar">
      <TitlebarDragRegion />
      <Button
        variant="ghost"
        leftIcon={Plus}
        onPress={onNewSession}
        disabled={disabled}
        testID="workspace-new-agent-session"
      >
        {t("workspace.header.actions.newAgent")}
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: {
    position: "relative",
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
}));
