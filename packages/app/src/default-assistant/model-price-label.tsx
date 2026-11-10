import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { assistantModelPriceStatus } from "./model-selection";

export function AssistantModelPriceLabel({
  provider,
  model,
}: {
  provider: string;
  model: AgentModelDefinition;
}) {
  const { t } = useTranslation();
  if (provider !== "opencode") return null;
  const status = assistantModelPriceStatus(model);
  return (
    <Text style={styles.label}>
      {status === "paid" ? t("defaultAssistant.pricePaid") : t("defaultAssistant.priceUnknown")}
    </Text>
  );
}
const styles = StyleSheet.create((theme) => ({
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
