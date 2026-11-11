import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { useBrowserStore } from "./store";
import { removeResidentBrowserWebview } from "./resident-webviews";

const PanelSchema = z.object({
  browserIds: z.array(z.string()),
  activeBrowserId: z.string().nullable(),
});
const PanelsSchema = z.object({ panelsByWorkspace: z.record(z.string(), PanelSchema) });
export type WorkspaceBrowserPanel = z.infer<typeof PanelSchema>;
interface PanelStore extends z.infer<typeof PanelsSchema> {
  openPage(workspaceKey: string, browserId: string): void;
  selectPage(workspaceKey: string, browserId: string): void;
  closePage(workspaceKey: string, browserId: string): void;
}

export const useWorkspaceBrowserStore = create<PanelStore>()(
  persist(
    (set) => ({
      panelsByWorkspace: {},
      openPage(workspaceKey, browserId) {
        set((state) => {
          const panel = state.panelsByWorkspace[workspaceKey];
          const browserIds = panel?.browserIds.includes(browserId)
            ? panel.browserIds
            : [...(panel?.browserIds ?? []), browserId];
          return {
            panelsByWorkspace: {
              ...state.panelsByWorkspace,
              [workspaceKey]: { browserIds, activeBrowserId: browserId },
            },
          };
        });
      },
      selectPage(workspaceKey, browserId) {
        set((state) => {
          const panel = state.panelsByWorkspace[workspaceKey];
          if (!panel?.browserIds.includes(browserId)) return state;
          return {
            panelsByWorkspace: {
              ...state.panelsByWorkspace,
              [workspaceKey]: { ...panel, activeBrowserId: browserId },
            },
          };
        });
      },
      closePage(workspaceKey, browserId) {
        set((state) => {
          const panel = state.panelsByWorkspace[workspaceKey];
          if (!panel?.browserIds.includes(browserId)) return state;
          const index = panel.browserIds.indexOf(browserId);
          const browserIds = panel.browserIds.filter((id) => id !== browserId);
          const activeBrowserId =
            panel.activeBrowserId === browserId
              ? (browserIds[Math.min(index, browserIds.length - 1)] ?? null)
              : panel.activeBrowserId;
          return {
            panelsByWorkspace: {
              ...state.panelsByWorkspace,
              [workspaceKey]: {
                ...panel,
                browserIds,
                activeBrowserId,
              },
            },
          };
        });
      },
    }),
    {
      name: "workspace-browser-panels",
      storage: createValidatedPersistStorage(AsyncStorage, PanelsSchema),
      partialize: (state) => ({ panelsByWorkspace: state.panelsByWorkspace }),
    },
  ),
);

export async function removeWorkspaceBrowserPage(input: {
  workspaceKey: string;
  browserId: string;
  browserHost?: DesktopHostBridge["browser"];
}): Promise<void> {
  useWorkspaceBrowserStore.getState().closePage(input.workspaceKey, input.browserId);
  useBrowserStore.getState().removeBrowser(input.browserId);
  removeResidentBrowserWebview(input.browserId);
  await (input.browserHost ?? getDesktopHost()?.browser)?.unregisterWorkspaceBrowser?.(
    input.browserId,
  );
}
