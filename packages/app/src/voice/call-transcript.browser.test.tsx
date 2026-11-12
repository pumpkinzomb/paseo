import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CallTranscript } from "./call-transcript";
const state = vi.hoisted(() => ({ active: true, fetches: 0, callId: "one" }));
vi.mock("@/components/retained-panel", () => ({ useRetainedPanelActive: () => state.active }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("lucide-react-native", () => ({ Phone: () => null, FileText: () => null }));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("react-native", () => ({
  View: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    testID,
    accessibilityState,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    testID?: string;
    accessibilityState?: { expanded?: boolean };
  }) => (
    <button
      type="button"
      data-testid={testID}
      onClick={onPress}
      aria-expanded={accessibilityState?.expanded}
    >
      {children}
    </button>
  ),
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    onClose,
  }: {
    children: React.ReactNode;
    onClose: () => void;
  }) => (
    <div role="dialog">
      <button type="button" onClick={onClose}>
        Close
      </button>
      {children}
    </div>
  ),
}));

vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => ({}) }));
vi.mock("@/data/query", () => ({
  useFetchQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    state.fetches++;
    const callId = queryKey[3];
    return {
      data: callId ? [{ id: String(callId), role: "user", text: "saved " + callId }] : undefined,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (s: unknown) => unknown) =>
    select({
      sessions: {
        host: {
          agentStreamTail: new Map([
            [
              "agent",
              [
                {
                  kind: "assistant_message",
                  id: "a",
                  messageId: "a",
                  source: "native_voice",
                  voiceCallId: "one",
                  text: "voice one",
                },
                {
                  kind: "assistant_message",
                  id: "b",
                  messageId: "b",
                  source: "native_voice",
                  voiceCallId: "two",
                  text: "voice two",
                },
                { kind: "user_message", id: "old", source: "native_voice", text: "legacy" },
                { kind: "user_message", id: "text", text: "ordinary text" },
              ],
            ],
          ]),
          agentStreamHead: new Map(),
        },
      },
    }),
}));
let container: HTMLDivElement;
let root: Root;
function render(callId: string | undefined = state.callId) {
  act(() => root.render(<CallTranscript serverId="host" agentId="agent" callId={callId} />));
}
function open() {
  act(() => container.querySelector<HTMLButtonElement>("button")!.click());
}
beforeEach(() => {
  Object.assign(state, { active: true, fetches: 0, callId: "one" });
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("opens the selected call only, combining persisted and loaded voice turns", () => {
  render();
  expect(state.fetches).toBe(0);
  open();
  expect(container.textContent).toContain("saved one");
  expect(container.textContent).toContain("voice one");
  expect(container.textContent).not.toContain("voice two");
  expect(container.textContent).not.toContain("legacy");
  expect(container.textContent).not.toContain("ordinary text");
});
it("closes and reopens the marker without leaking another call", () => {
  render();
  open();
  act(() => container.querySelector<HTMLButtonElement>("[role=dialog] button")!.click());
  expect(container.querySelector("[role=dialog]")).toBeNull();
  state.callId = "two";
  render();
  open();
  expect(container.textContent).toContain("voice two");
  expect(container.textContent).not.toContain("voice one");
});
it("closes when switching call identity or retained panel", () => {
  render();
  open();
  state.callId = "two";
  render();
  expect(container.querySelector("[role=dialog]")).toBeNull();
  open();
  state.active = false;
  render();
  expect(container.querySelector("[role=dialog]")).toBeNull();
  state.active = true;
  render();
  expect(container.querySelector("[role=dialog]")).toBeNull();
});
it("preserves legacy records without claiming inferred call boundaries", () => {
  act(() => root.render(<CallTranscript serverId="host" agentId="agent" />));
  open();
  expect(container.textContent).toContain("legacy");
  expect(container.textContent).not.toContain("voice one");
  expect(container.textContent).not.toContain("voice two");
});
