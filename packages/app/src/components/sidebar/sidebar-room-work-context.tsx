import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";

export interface SidebarRoomWork {
  parentKey: string;
  subSessions: readonly SidebarWorkspacePlacement[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  renderRow: (placement: SidebarWorkspacePlacement) => ReactNode;
}
const Context = createContext<SidebarRoomWork | null>(null);
export function SidebarRoomWorkProvider({
  children,
  parentKey,
  subSessions,
  workspaceEntriesByKey,
  renderRow,
}: SidebarRoomWork & { children: ReactNode }) {
  const value = useMemo(
    () => ({ parentKey, subSessions, workspaceEntriesByKey, renderRow }),
    [parentKey, subSessions, workspaceEntriesByKey, renderRow],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSidebarRoomWork(parentKey: string) {
  const value = useContext(Context);
  // Rendering a nested workspace row must not repeat its ancestor's children.
  return value?.parentKey === parentKey ? value : null;
}
