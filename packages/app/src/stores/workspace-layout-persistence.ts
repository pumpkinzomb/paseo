import type { StateStorage } from "zustand/middleware";

export const LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY = "workspace-layout-state";
export const WORKSPACE_LAYOUT_STORAGE_KEY = "workspace-layout-state-browser-workspace-v1";

/**
 * Older builds reject browser_workspace targets and delete the entire layout blob.
 * Keep their last layout untouched, and import it into our separate namespace once.
 * A rollback therefore restores its pre-upgrade layout, not subsequent layout edits;
 * returning to this build restores those newer edits from the separate key.
 * This is a layout snapshot boundary, not a bidirectional layout merge.
 */
export function createBrowserWorkspaceLayoutStorage(backing: StateStorage): StateStorage {
  return {
    async getItem(name) {
      const current = await backing.getItem(name);
      if (current !== null || name !== WORKSPACE_LAYOUT_STORAGE_KEY) return current;
      const legacy = await backing.getItem(LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY);
      if (legacy !== null) await backing.setItem(name, legacy);
      return legacy;
    },
    setItem: (name, value) => backing.setItem(name, value),
    removeItem: (name) => backing.removeItem(name),
  };
}
