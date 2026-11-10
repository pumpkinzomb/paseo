import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { MessageCircle, Plus, SlidersHorizontal } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { buildHostRootRoute } from "@/utils/host-routes";
import { AssistantModelPicker } from "./model-picker";
import { buildAssistantModelRoute, type AssistantModelSelection } from "./model-selection";
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
  const supportsModelSelection = useHostFeature(serverId, "defaultAssistantModelSelection");
  const [pickerOpen, setPickerOpen] = useState(false);
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!active) {
      creatingRef.current = false;
      setCreating(false);
      setPickerOpen(false);
    }
  }, [active]);
  const resume = useCallback(
    () => router.navigate(buildHostRootRoute(serverId)),
    [router, serverId],
  );
  const newConversation = useCallback(() => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    router.push(`/h/${encodeURIComponent(serverId)}/assistant?new=${randomUUID()}` as Href);
  }, [router, serverId]);
  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const selectModel = useCallback(
    (selection: AssistantModelSelection) => {
      if (creatingRef.current) return;
      creatingRef.current = true;
      setCreating(true);
      setPickerOpen(false);
      router.push(buildAssistantModelRoute(serverId, selection, randomUUID()) as Href);
    },
    [router, serverId],
  );
  if (!supported) return null;
  return (
    <View style={styles.row} testID="default-assistant-toolbar">
      <Button
        variant="ghost"
        leftIcon={MessageCircle}
        onPress={resume}
        testID="default-assistant-resume"
      >
        {t("defaultAssistant.title")}
      </Button>
      <Button
        variant="ghost"
        leftIcon={Plus}
        onPress={newConversation}
        disabled={creating}
        testID="default-assistant-new"
      >
        {t("defaultAssistant.newConversation")}
      </Button>
      {supportsModelSelection ? (
        <Button
          variant="ghost"
          leftIcon={SlidersHorizontal}
          onPress={openPicker}
          disabled={creating}
          testID="default-assistant-models"
        >
          {t("defaultAssistant.chooseModel")}
        </Button>
      ) : null}
      <AssistantModelPicker
        serverId={serverId}
        visible={pickerOpen && active}
        onClose={closePicker}
        onSelect={selectModel}
      />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
}));
