import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useBrowserStore } from "./store";
import { useWorkspaceBrowserStore } from "./workspace-store";
import { mountResidentBrowserPageRestore } from "./restore-resident-pages";

const stores = [useBrowserStore, useWorkspaceBrowserStore, useWorkspaceLayoutStore];
const storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
beforeEach(async () => {
  for (const store of stores) {
    store.persist.setOptions({ storage });
    await store.persist.rehydrate();
  }
  useBrowserStore.setState({ browsersById: {} });
  useWorkspaceBrowserStore.setState({ panelsByWorkspace: {} });
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    sidePaneIdByWorkspace: {},
    focusRequest: null,
  });
});
afterEach(() => vi.restoreAllMocks());
function savedPage(key: string, url: string) {
  const id = useBrowserStore.getState().createBrowser({ initialUrl: url });
  useWorkspaceBrowserStore.getState().openPage(key, id);
  return id;
}
describe("saved resident browser restoration", () => {
  it("restores background workspace pages without changing selection or layout", () => {
    const id = savedPage("host:background", "https://example.com/saved");
    savedPage("another:workspace", "https://example.org");
    useBrowserStore.getState().createBrowser({ initialUrl: "https://example.net/closed" });
    const snapshot = useWorkspaceBrowserStore.getState().panelsByWorkspace;
    const ensure = vi.fn(() => null);
    const stop = mountResidentBrowserPageRestore("host", ensure);
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      browserId: id,
      workspaceId: "background",
      url: "https://example.com/saved",
    });
    expect(useWorkspaceBrowserStore.getState().panelsByWorkspace).toBe(snapshot);
    expect(useWorkspaceLayoutStore.getState().focusRequest).toBe(null);
    stop();
  });
  it("restores legacy layout pages once even when also in the page panel", () => {
    const id = savedPage("host:wks", "https://example.com");
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: "host:wks",
      target: { kind: "browser", browserId: id },
      intent: "reveal",
    });
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace;
    const ensure = vi.fn(() => null);
    const stop = mountResidentBrowserPageRestore("host", ensure);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toBe(layout);
    stop();
  });
  it("waits for hydration and reads current saved pages instead of an early snapshot", () => {
    let hydrated = false;
    let onHydration: (() => void) | undefined;
    vi.spyOn(useBrowserStore.persist, "hasHydrated").mockImplementation(() => hydrated);
    const unsubscribe = vi.fn();
    vi.spyOn(useBrowserStore.persist, "onFinishHydration").mockImplementation((callback) => {
      onHydration = () => callback(useBrowserStore.getState());
      return unsubscribe;
    });
    const ensure = vi.fn(() => null);
    const stop = mountResidentBrowserPageRestore("host", ensure);
    expect(ensure).not.toHaveBeenCalled();
    const id = savedPage("host:wks", "https://example.com");
    hydrated = true;
    onHydration?.();
    onHydration?.();
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      browserId: id,
      workspaceId: "wks",
      url: "https://example.com",
    });
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("does not resurrect closed pages or restore after the host unmounts", () => {
    const id = savedPage("host:wks", "https://example.com");
    useWorkspaceBrowserStore.getState().closePage("host:wks", id);
    const ensure = vi.fn(() => null);
    mountResidentBrowserPageRestore("host", ensure)();
    expect(ensure).not.toHaveBeenCalled();
    let onHydration: (() => void) | undefined;
    vi.spyOn(useBrowserStore.persist, "hasHydrated").mockReturnValue(false);
    vi.spyOn(useBrowserStore.persist, "onFinishHydration").mockImplementation((callback) => {
      onHydration = () => callback(useBrowserStore.getState());
      return () => {};
    });
    const stop = mountResidentBrowserPageRestore("host", ensure);
    savedPage("host:wks", "https://example.com");
    stop();
    vi.spyOn(useBrowserStore.persist, "hasHydrated").mockReturnValue(true);
    onHydration?.();
    expect(ensure).not.toHaveBeenCalled();
  });
});
