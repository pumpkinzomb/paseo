import { createContext, useContext, type ReactNode } from "react";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";

type SubSessionChildrenByParentKey = ReadonlyMap<string, readonly SidebarWorkspacePlacement[]>;

const EMPTY_CHILDREN: SubSessionChildrenByParentKey = new Map();

// A context of its own rather than a field on the sidebar model: rows read it, and the model
// changes on every status tick while this map only changes when parentage does.
const SidebarSubSessionsContext = createContext<SubSessionChildrenByParentKey>(EMPTY_CHILDREN);

export function SidebarSubSessionsProvider({
  childrenByParentKey,
  children,
}: {
  childrenByParentKey: SubSessionChildrenByParentKey;
  children: ReactNode;
}) {
  return (
    <SidebarSubSessionsContext.Provider value={childrenByParentKey}>
      {children}
    </SidebarSubSessionsContext.Provider>
  );
}

export function useSidebarSubSessionChildren(): SubSessionChildrenByParentKey {
  return useContext(SidebarSubSessionsContext);
}
