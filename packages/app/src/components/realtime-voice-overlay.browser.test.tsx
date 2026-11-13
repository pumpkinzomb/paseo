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
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: unknown) => component,
}));
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
const catalog = vi.hoisted(() => ({
  data: { voices: ["maple", "juniper"] } as { voices: string[] } | undefined,
  error: null as Error | null,
  refetch: vi.fn(),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => ({}) }));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => "current-agent" }));
vi.mock("@/data/query", () => ({ useFetchQuery: () => catalog }));
vi.mock("@/components/settings", () => ({
  SettingsCard: () => null,
  SettingsSection: () => null,
  SettingsSelect: () => null,
}));
vi.mock("@/voice/native-voice-preference", () => {
  const listeners = new Set<() => void>();
  const setVoice = (v: string) => {
    state.selected = v;
    listeners.forEach((notify) => notify());
  };
  return {
    useNativeVoicePreference: (
      selector: (s: { voice: string; setVoice: (v: string) => void }) => unknown,
    ) => {
      const voice = React.useSyncExternalStore(
        (notify) => {
          listeners.add(notify);
          return () => {
            listeners.delete(notify);
          };
        },
        () => state.selected,
      );
      return selector({ voice, setVoice });
    },
  };
});
vi.mock("@/components/ui/dropdown-menu", () => {
  const Context = React.createContext({ open: false, setOpen: (_value: boolean) => {} });
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      const value = React.useMemo(() => ({ open, setOpen }), [open]);
      return <Context.Provider value={value}>{children}</Context.Provider>;
    },
    DropdownMenuTrigger: ({
      children,
      disabled,
      testID,
    }: {
      children: React.ReactNode;
      disabled?: boolean;
      testID: string;
    }) => {
      const { open, setOpen } = React.useContext(Context);
      return (
        <button
          type="button"
          data-testid={testID}
          disabled={disabled}
          onClick={() => setOpen(!open)}
        >
          {children}
        </button>
      );
    },
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      React.useContext(Context).open ? <div role="menu">{children}</div> : null,
    DropdownMenuHint: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    DropdownMenuItem: ({
      children,
      onSelect,
      selected,
    }: {
      children: React.ReactNode;
      onSelect: () => void;
      selected?: boolean;
    }) => {
      const { setOpen } = React.useContext(Context);
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selected}
          onClick={() => {
            onSelect();
            setOpen(false);
          }}
        >
          {children}
        </button>
      );
    },
  };
});
let root: Root;
let el: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  el?.remove();
  state.voice.voiceRoute = "native";
  state.selected = "maple";
  catalog.data = { voices: ["maple", "juniper"] };
  catalog.error = null;
  catalog.refetch.mockClear();
});
it("selects a voice directly from a menu without a settings dialog or call restart", async () => {
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
  expect(el.querySelector('[role="dialog"]')).toBeNull();
  expect(el.querySelector('[role="menu"]')?.textContent).toContain("voiceCall.nextCallVoiceHint");
  const select = [...el.querySelectorAll("button")].find((b) => b.textContent === "juniper")!;
  await act(async () => select.click());
  expect(state.selected).toBe("juniper");
  expect(state.voice.effectiveVoice).toBe("maple");
  expect(trigger.textContent).toBe("voiceCall.nextVoiceSelection");
  expect(el.querySelector('[role="menu"]')).toBeNull();
  expect(stop).not.toHaveBeenCalled();
  expect(mute).not.toHaveBeenCalled();
  await act(async () => trigger.click());
  expect(el.querySelector('[aria-checked="true"]')?.textContent).toBe("juniper");
  await act(async () => trigger.click());
  expect(el.querySelector('[role="menu"]')).toBeNull();
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

it("shows catalog failure and retry without exposing stale voice options", async () => {
  catalog.error = new Error("Disconnected");
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
  await act(async () =>
    (el.querySelector('[data-testid="voice-call-change-voice"]') as HTMLButtonElement).click(),
  );
  expect(el.textContent).toContain("voiceCall.catalogFailed");
  expect(el.textContent).not.toContain("juniper");
  const retry = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "common.actions.retry",
  )!;
  await act(async () => retry.click());
  expect(catalog.refetch).toHaveBeenCalledOnce();
});
it("disables selection while the call is switching", async () => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root.render(
      <RealtimeVoiceOverlay isMuted={false} isSwitching onStop={vi.fn()} onToggleMute={vi.fn()} />,
    ),
  );
  expect(
    (el.querySelector('[data-testid="voice-call-change-voice"]') as HTMLButtonElement).disabled,
  ).toBe(true);
});
