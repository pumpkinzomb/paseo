import { usePaneContext } from "@/panels/pane-context";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { BrowserWorkspaceContent } from "./workspace-content";
export function WorkspaceBrowserPanel() {
  const { serverId, workspaceId } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const active = useRetainedPanelActive();
  return (
    <BrowserWorkspaceContent
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={cwd}
      active={active}
    />
  );
}
