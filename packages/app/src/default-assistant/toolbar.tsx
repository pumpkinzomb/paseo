import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { useHostFeature } from "@/runtime/host-features";

export function DefaultAssistantToolbar({
  serverId,
  active,
}: {
  serverId: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const supported = useHostFeature(serverId, "defaultAssistant");
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!active) {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [active]);
  const newConversation = useCallback(() => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    router.push(`/h/${encodeURIComponent(serverId)}/assistant?new=${randomUUID()}` as Href);
  }, [router, serverId]);
  if (!supported) return null;
  return (
    <View style={styles.row} testID="default-assistant-toolbar">
      <TitlebarDragRegion />
      <Button
        variant="ghost"
        leftIcon={Plus}
        onPress={newConversation}
        disabled={creating}
        testID="default-assistant-new"
      >
        {t("defaultAssistant.newConversation")}
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
