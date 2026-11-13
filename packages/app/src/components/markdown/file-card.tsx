import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useAssistantFileLinkActions } from "@/assistant-file-links";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useStableEvent } from "@/hooks/use-stable-event";
import { citationLabel, type FileCitation } from "./file-citations";

export function FileCard({ path, title }: FileCitation) {
  const citation = { path, title };
  const { t } = useTranslation();
  const actions = useAssistantFileLinkActions();
  const source = { href: citation.path, text: citation.path };
  const open = useStableEvent(() => actions.open(source, "explorer"));
  const local = actions.canResolveFile(source);
  const detail = local ? t("fileCitation.openPreview") : t("fileCitation.openOriginal");
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={`${citationLabel(citation)} — ${detail}`}
      disabled={!actions.canOpen(source)}
      onPress={open}
      style={styles.card}
      testID="assistant-file-card"
    >
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {citationLabel(citation)}
        </Text>
        <Text style={styles.detail}>{detail}</Text>
      </View>
      <Text style={styles.detail} accessibilityElementsHidden>
        {local ? "→" : "↗"}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  body: { flex: 1, gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
