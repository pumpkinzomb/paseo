/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop -- Isolated UI fixtures. */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RealtimeVoiceOverlay } from "./realtime-voice-overlay";
vi.mock("lucide-react-native", () => ({
  ChevronDown: () => null,
  Mic: () => null,
  MicOff: () => null,
  PhoneOff: () => null,
}));
const state = vi.hoisted(() => ({
  voice: {
    phase: "waiting",
    voiceRoute: "native",
    effectiveVoice: "maple",
    activeServerId: "host",
    activeAgentId: "current-agent",
  },
  selected: "maple",
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/contexts/voice-context", () => ({
  useVoice: () => state.voice,
  useVoiceTelemetry: () => ({ volume: 0, isSpeaking: false }),
}));
vi.mock("./volume-meter", () => ({ VolumeMeter: () => null }));
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
    <button type="button" onClick={onPress} disabled={disabled} data-testid={testID}>
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
// Exercise the overlay's handoff and call lifetime without fetching a real catalog or changing saved preferences.
vi.mock("@/voice/native-call-settings", () => ({
  NativeCallSettings: ({ serverId, agentId }: { serverId: string; agentId: string }) => (
    <button
      type="button"
      data-target={`${serverId}/${agentId}`}
      onClick={() => {
        state.selected = "juniper";
      }}
    >
      Choose juniper
    </button>
  ),
}));
let root: Root;
let el: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  el?.remove();
  state.voice.voiceRoute = "native";
  state.selected = "maple";
});
it("opens the current call's voice picker without restarting or changing its effective voice", async () => {
  const stop = vi.fn();
  const mute = vi.fn();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root.render(
      <RealtimeVoiceOverlay
        isMuted={false}
        isSwitching={false}
        onStop={stop}
        onToggleMute={mute}
      />,
    ),
  );
  const trigger = el.querySelector('[data-testid="voice-call-change-voice"]') as HTMLButtonElement;
  expect(trigger.textContent).toBe("maple");
  expect(el.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => trigger.click());
  expect(el.querySelector('[role="dialog"]')?.textContent).toContain("voiceCall.nextCallVoiceHint");
  const select = el.querySelector('[data-target="host/current-agent"]') as HTMLButtonElement;
  await act(async () => select.click());
  expect(state.selected).toBe("juniper");
  expect(trigger.textContent).toBe("maple");
  expect(stop).not.toHaveBeenCalled();
  expect(mute).not.toHaveBeenCalled();
  const close = [...el.querySelectorAll("button")].find(
    (button) => button.textContent === "voiceSetup.close",
  )!;
  await act(async () => close.click());
  expect(el.querySelector('[role="dialog"]')).toBeNull();
});
it("does not offer a Codex picker for a speech-provider call", async () => {
  state.voice.voiceRoute = "speech";
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root.render(
      <RealtimeVoiceOverlay
        isMuted={false}
        isSwitching={false}
        onStop={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    ),
  );
  expect(el.querySelector('[data-testid="voice-call-change-voice"]')).toBeNull();
  expect(el.textContent).toContain("voiceCall.routeSpeech");
});
