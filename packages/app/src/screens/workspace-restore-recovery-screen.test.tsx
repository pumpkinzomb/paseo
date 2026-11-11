import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRestoreRecoveryScreen } from "./workspace-restore-recovery-screen";
import { en } from "@/i18n/resources/en";
import { ko } from "@/i18n/resources/ko";

const mocks = vi.hoisted(() => ({ push: vi.fn(), actions: new Map<string, () => void>() }));
vi.mock("expo-router", () => ({ router: { push: mocks.push } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      for (const locale of [en, ko]) {
        const value = key
          .split(".")
          .reduce<unknown>(
            (parent, part) =>
              parent && typeof parent === "object" ? Reflect.get(parent, part) : undefined,
            locale,
          );
        if (typeof value !== "string") throw new Error(`Untranslated recovery label: ${key}`);
      }
      return key;
    },
  }),
}));
vi.mock("react-native", () => ({
  Text: ({ children }: React.PropsWithChildren) => React.createElement("span", null, children),
  View: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("@/components/desktop/titlebar-drag-region", () => ({ TitlebarDragRegion: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: React.PropsWithChildren<{ onPress: () => void }>) => {
    mocks.actions.set(String(children), onPress);
    return React.createElement("button", { type: "button" }, children);
  },
}));

beforeEach(() => {
  mocks.push.mockReset();
  mocks.actions.clear();
});

describe("workspace recovery choices", () => {
  it("does not navigate automatically, and retries only when requested", () => {
    const retry = vi.fn();
    renderToStaticMarkup(<WorkspaceRestoreRecoveryScreen serverId="saved-host" retry={retry} />);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    mocks.actions.get("common.actions.retry")?.();
    expect(retry).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("lets the user deliberately open the saved host settings or choose a project", () => {
    renderToStaticMarkup(<WorkspaceRestoreRecoveryScreen serverId="saved-host" retry={vi.fn()} />);
    mocks.actions.get("startup.workspaceRestore.hostSettings")?.();
    expect(mocks.push).toHaveBeenLastCalledWith("/settings/hosts/saved-host");
    mocks.actions.get("defaultAssistant.projects")?.();
    expect(mocks.push).toHaveBeenLastCalledWith("/open-project");
  });
});
