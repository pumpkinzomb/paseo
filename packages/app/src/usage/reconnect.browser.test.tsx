import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { UsageCard } from "./card";
import type { UsageDisplay } from "./display";
import type { UsageReportEntry } from "./types";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  login: vi.fn().mockResolvedValue(undefined),
  refreshState: "idle" as "idle" | "pending",
}));
// Keep real tooltip and React Native text validation; only omit animation timing.
vi.mock("@/components/ui/floating", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/ui/floating")>();
  const { View } = await import("react-native");
  return {
    ...original,
    FloatingSurface: React.forwardRef<
      React.ComponentRef<typeof View>,
      React.ComponentProps<typeof original.FloatingSurface>
    >(function StaticFloatingSurface({ entering, exiting, frameStyle, style, ...props }, ref) {
      void entering;
      void exiting;
      return (
        <View
          {...(props as React.ComponentProps<typeof View>)}
          ref={ref}
          style={[frameStyle, style]}
        />
      );
    }),
  };
});
vi.mock("@/hooks/use-is-local-daemon", () => ({
  useIsLocalDaemon: () => true,
}));
vi.mock("@/desktop/electron/host", () => ({
  getElectronHost: () => ({ usageAuth: { start: state.login } }),
}));
vi.mock("./source-icon", () => ({ UsageSourceIcon: () => null }));
vi.mock("./queries", () => ({ useReportRefresh: () => state }));
const entry: UsageReportEntry = {
  id: "cursor:test",
  account: {},
  fetchedAt: "2026-01-01T00:00:00.000Z",
  sourceId: "cursor",
  sourceLabel: "Cursor",
  report: { status: "unavailable", problem: { kind: "rejected", status: 401 } },
};
const display = {} as UsageDisplay;
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("React", React);
  state.refresh.mockClear();
  state.login.mockReset().mockResolvedValue(undefined);
  state.refreshState = "idle";
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function render() {
  act(() =>
    root.render(
      <UsageCard
        serverId="host"
        entry={entry}
        display={display}
        pinnable={false}
        refreshable={true}
      />,
    ),
  );
}
it("starts sign-in, not a refresh of rejected credentials", async () => {
  render();
  const button = container.querySelector<HTMLElement>('[data-testid="usage-reconnect"]')!;
  expect(button).not.toBeNull();
  const refreshButton = container.querySelector('[data-testid="usage-refresh"]')!;
  expect(
    refreshButton.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(container.textContent).toContain("Complete the browser login");
  await act(async () => button.click());
  expect(state.login).toHaveBeenCalledWith("cursor");
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("renders the reconnect guidance tooltip as Text without raw text node warnings", async () => {
  await i18n.changeLanguage("ko");
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    render();
    const button = container.querySelector<HTMLElement>('[data-testid="usage-reconnect"]')!;
    act(() => {
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    });
    await vi.waitFor(() => {
      const hint = i18n.t("providerUsage.reconnectHint");
      expect(document.body.textContent?.split(hint).length).toBeGreaterThan(2);
    });
    expect(errors.mock.calls.flat().join(" ")).not.toContain("Unexpected text node");
    await act(async () => button.click());
    expect(state.login).toHaveBeenCalledWith("cursor");
    expect(state.refresh).toHaveBeenCalledOnce();
    act(() => {
      button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    errors.mockRestore();
  }
});

it("waits for authentication, disables duplicate clicks and shows cancellation failures", async () => {
  let fail!: (reason: Error) => void;
  state.login.mockImplementation(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  render();
  const button = container.querySelector<HTMLElement>('[data-testid="usage-reconnect"]')!;
  act(() => button.click());
  expect(state.refresh).not.toHaveBeenCalled();
  act(() => button.click());
  expect(state.login).toHaveBeenCalledOnce();
  await act(async () => fail(new Error("cancelled")));
  expect(container.querySelector('[data-testid="usage-auth-error"]')).not.toBeNull();
  expect(state.refresh).not.toHaveBeenCalled();
});
