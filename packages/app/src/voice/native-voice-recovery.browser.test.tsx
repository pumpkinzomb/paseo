/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop -- Test fixtures are intentionally recreated per case. */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NativeVoiceRecovery } from "./native-voice-recovery";
import type { VoiceRuntime } from "./voice-runtime";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/desktop/dev-update/transient-state", () => ({ useUpdateTransientBlocker: () => {} }));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    footer,
  }: {
    children: React.ReactNode;
    footer: React.ReactNode;
  }) => (
    <div role="dialog">
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("./native-call-settings", () => ({
  NativeCallSettings: ({ onReady }: { onReady: (ready: boolean) => void }) => (
    <button type="button" onClick={() => onReady(true)}>
      Choose supported voice
    </button>
  ),
}));
let root: Root;
let el: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  el?.remove();
});
it("waits for an explicit compatible choice, retains failures, and permits retry", async () => {
  const startVoice = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValue(undefined);
  const onClose = vi.fn();
  const runtime = {
    startVoice,
    stopVoice: vi.fn(),
    isVoiceModeForAgent: () => false,
  } as unknown as VoiceRuntime;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root.render(
      <NativeVoiceRecovery serverId="host" agentId="agent" runtime={runtime} onClose={onClose} />,
    ),
  );
  const retry = el.querySelector('[data-testid="native-voice-retry"]') as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  expect(startVoice).not.toHaveBeenCalled();
  await act(async () => (el.querySelector("button") as HTMLButtonElement).click());
  expect(retry.disabled).toBe(false);
  await act(async () => retry.click());
  expect(el.textContent).toContain("Connection lost");
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => retry.click());
  expect(startVoice).toHaveBeenCalledTimes(2);
  expect(startVoice).toHaveBeenLastCalledWith("host", "agent");
  expect(onClose).toHaveBeenCalledTimes(1);
});
