import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenuItem, useDropdownMenuClose } from "@/components/ui/dropdown-menu";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useDeleteWorkspaceSessions } from "@/hooks/use-delete-workspace-sessions";
import type { Theme } from "@/styles/theme";

const ThemedTrash = withUnistyles(Trash2);
const destructiveColor = (theme: Theme) => ({ color: theme.colors.destructive });
const deleteIcon = <ThemedTrash size={14} uniProps={destructiveColor} />;

export function WorkspaceSessionDeleteItem({
  serverId,
  workspaceId,
  workspaceKey,
  surface,
}: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  surface: "context" | "dropdown";
}) {
  const { t } = useTranslation();
  const close = useDropdownMenuClose();
  const { remove, pending } = useDeleteWorkspaceSessions(serverId, workspaceId, close);
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  return (
    <Item
      testID={`sidebar-workspace-menu-delete-session-${workspaceKey}`}
      leading={deleteIcon}
      destructive
      disabled={!remove || pending}
      closeOnSelect={false}
      onSelect={remove}
    >
      {t("workspaceSessionDeletion.menu")}
    </Item>
  );
}
