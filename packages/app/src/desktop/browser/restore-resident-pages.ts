import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useBrowserStore } from "./store";
import { useWorkspaceBrowserStore } from "./workspace-store";
import { ensureResidentBrowserWebview } from "./resident-webviews";

/** Restore saved open pages without navigating, focusing, or revealing their workspace. */
export function mountResidentBrowserPageRestore(
  serverId: string,
  ensure = ensureResidentBrowserWebview,
): () => void {
  let disposed = false;
  let restored = false;
  const prefix = `${serverId}:`;
  const stores = [useBrowserStore, useWorkspaceBrowserStore, useWorkspaceLayoutStore];
  const restore = () => {
    if (disposed || restored || stores.some((store) => !store.persist.hasHydrated())) return;
    restored = true;
    const pages = new Map<string, string>();
    for (const [key, panel] of Object.entries(
      useWorkspaceBrowserStore.getState().panelsByWorkspace,
    )) {
      if (!key.startsWith(prefix)) continue;
      const workspaceId = key.slice(prefix.length);
      if (!workspaceId) continue;
      for (const id of panel.browserIds) pages.set(id, workspaceId);
    }
    for (const [key, layout] of Object.entries(
      useWorkspaceLayoutStore.getState().layoutByWorkspace,
    )) {
      if (!key.startsWith(prefix)) continue;
      const workspaceId = key.slice(prefix.length);
      if (!workspaceId) continue;
      for (const tab of collectAllTabs(layout.root)) {
        if (tab.target.kind === "browser") pages.set(tab.target.browserId, workspaceId);
      }
    }
    const browsers = useBrowserStore.getState().browsersById;
    for (const [browserId, workspaceId] of pages) {
      const browser = browsers[browserId];
      if (!browser) continue;
      try {
        // Existing visible/resident guests are reused without resetting their URL.
        ensure({ browserId, workspaceId, url: browser.url });
      } catch (error) {
        // One failed guest must not prevent other saved pages from restoring.
        console.warn("Failed to restore saved browser page", browserId, error);
      }
    }
  };
  const unsubscribers = stores.map((store) => store.persist.onFinishHydration(restore));
  restore();
  return () => {
    disposed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
