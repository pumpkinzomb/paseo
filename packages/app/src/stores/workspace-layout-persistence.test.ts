import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "../storage/validated-persist-storage";
import { WorkspaceLayoutPersistedStateSchema } from "./workspace-layout-storage";
import {
  createBrowserWorkspaceLayoutStorage,
  LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY as LEGACY,
  WORKSPACE_LAYOUT_STORAGE_KEY as CURRENT,
} from "./workspace-layout-persistence";

function fixture(kind: "browser" | "browser_workspace") {
  return {
    version: 2,
    state: {
      layoutByWorkspace: {
        workspace: {
          focusedPaneId: "main",
          root: {
            kind: "pane",
            pane: {
              id: "main",
              tabIds: ["agent", "browser"],
              focusedTabId: "agent",
              tabs: [
                { tabId: "agent", target: { kind: "agent", agentId: "keep-me" }, createdAt: 1 },
                {
                  tabId: "browser",
                  target: kind === "browser" ? { kind, browserId: "page-1" } : { kind },
                  createdAt: 2,
                },
              ],
            },
          },
        },
      },
      pinnedAgentIdsByWorkspace: { workspace: ["keep-me"] },
    },
  };
}
function setup(raw: string) {
  const values = new Map([[LEGACY, raw]]);
  const backing: StateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const storage = createValidatedPersistStorage(
    createBrowserWorkspaceLayoutStorage(backing),
    WorkspaceLayoutPersistedStateSchema,
  );
  return { values, storage };
}

describe("browser workspace layout persistence boundary", () => {
  it("imports the full old layout without changing the rollback snapshot", async () => {
    const raw = JSON.stringify(fixture("browser"));
    const { values, storage } = setup(raw);
    expect(await storage.getItem(CURRENT)).toEqual(fixture("browser"));
    expect(values.get(CURRENT)).toBe(raw);
    expect(values.get(LEGACY)).toBe(raw);
  });

  it("keeps new edits through rollback and return, without sending new targets to the old key", async () => {
    const raw = JSON.stringify(fixture("browser"));
    const { values, storage } = setup(raw);
    await storage.getItem(CURRENT);
    const upgraded = WorkspaceLayoutPersistedStateSchema.parse(fixture("browser_workspace").state);
    await storage.setItem(CURRENT, { state: upgraded, version: 2 });
    expect(values.get(LEGACY)).toBe(raw);
    // A rollback may change its own layout, but cannot overwrite the upgraded layout.
    values.set(LEGACY, JSON.stringify({ version: 2, state: { layoutByWorkspace: {} } }));
    expect(await storage.getItem(CURRENT)).toEqual({ state: upgraded, version: 2 });
  });

  it("losslessly imports a legacy key already written by the browser preview", async () => {
    const raw = JSON.stringify(fixture("browser_workspace"));
    const { values, storage } = setup(raw);
    expect(await storage.getItem(CURRENT)).toEqual(fixture("browser_workspace"));
    expect(values.get(CURRENT)).toBe(raw);
    // This contaminated legacy key still requires a compatible rollback build.
    expect(values.get(LEGACY)).toBe(raw);
  });

  it("does not remove the old snapshot when a copied layout fails validation", async () => {
    const { values, storage } = setup("invalid json");
    expect(await storage.getItem(CURRENT)).toBeNull();
    expect(values.get(LEGACY)).toBe("invalid json");
    expect(values.has(CURRENT)).toBe(false);
  });
});
