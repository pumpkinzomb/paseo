import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarLeadIdentitySheet } from "./sidebar-lead-identity";
const state = vi.hoisted(() => ({
  connected: true,
  supported: true,
  persona: "Sunny original",
  latest: "Sunny original",
  get: vi.fn(),
  patch: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => state.supported }));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "host", label: "Mac" }],
  useHostRuntimeIsConnected: () => state.connected,
  useHostRuntimeClient: () => ({ getDaemonConfig: state.get, patchDaemonConfig: state.patch }),
}));
vi.mock("@/data/query", () => ({
  useFetchQuery: () => ({
    data: { leadPersona: state.persona },
    isFetchedAfterMount: true,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: state.confirm }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    header,
    footer,
    onClose,
  }: {
    children: React.ReactNode;
    header: { subtitle?: React.ReactNode };
    footer?: React.ReactNode;
    onClose(): void;
  }) => (
    <section>
      <div data-testid="identity-subtitle">{header.subtitle}</div>
      <button type="button" onClick={onClose}>
        Close
      </button>
      {children}
      {footer}
    </section>
  ),
}));
vi.mock("@/components/ui/form-field", () => ({
  Field: ({ children, error }: { children: React.ReactNode; error: string }) => (
    <div>
      {children}
      {error}
    </div>
  ),
  FormTextInput: ({
    initialValue,
    resetKey,
    onChangeText,
    editable,
  }: {
    initialValue: string;
    resetKey: number;
    onChangeText(value: string): void;
    editable: boolean;
  }) => {
    const change = React.useCallback(
      (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.target.value),
      [onChangeText],
    );
    return (
      <textarea
        key={resetKey}
        aria-label="Identity"
        defaultValue={initialValue}
        disabled={!editable}
        onChange={change}
      />
    );
  },
}));
beforeEach(() => {
  vi.stubGlobal("React", React);
  state.connected = true;
  state.supported = true;
  state.persona = "Sunny original";
  state.latest = state.persona;
  state.get.mockReset().mockImplementation(async () => ({ config: { leadPersona: state.latest } }));
  state.patch.mockReset().mockImplementation(async ({ leadPersona }: { leadPersona: string }) => ({
    config: { leadPersona: leadPersona || "Sunny default" },
  }));
  state.confirm.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);
it("saves a common identity and restores the effective default", async () => {
  render(<SidebarLeadIdentitySheet visible onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Sunny edited" } });
  fireEvent.click(screen.getByText("leadIdentity.save"));
  await waitFor(() => expect(state.patch).toHaveBeenCalledWith({ leadPersona: "Sunny edited" }));
  await screen.findByText("leadIdentity.saved");
  state.latest = "Sunny edited";
  fireEvent.click(screen.getByText("leadIdentity.reset"));
  await waitFor(() => expect(state.patch).toHaveBeenCalledWith({ leadPersona: "" }));
  await waitFor(() =>
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Sunny default"),
  );
});
it("keeps unsaved text on disconnection and refuses a stale overwrite", async () => {
  const close = vi.fn();
  const view = render(<SidebarLeadIdentitySheet visible onClose={close} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved" } });
  state.connected = false;
  view.rerender(<SidebarLeadIdentitySheet visible onClose={close} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Unsaved");
  expect(screen.getByText("leadIdentity.offline")).toBeTruthy();
  state.connected = true;
  state.latest = "Changed elsewhere";
  view.rerender(<SidebarLeadIdentitySheet visible onClose={close} />);
  fireEvent.click(screen.getByText("leadIdentity.save"));
  await screen.findByText("leadIdentity.conflict");
  expect(state.patch).not.toHaveBeenCalled();
  state.confirm.mockResolvedValue(false);
  fireEvent.click(screen.getByText("Close"));
  await waitFor(() => expect(state.confirm).toHaveBeenCalled());
  expect(close).not.toHaveBeenCalled();
});
it("reopening a dismissed sheet discards only its unsaved draft", () => {
  const close = vi.fn();
  const view = render(<SidebarLeadIdentitySheet visible onClose={close} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved" } });
  view.rerender(<SidebarLeadIdentitySheet visible={false} onClose={close} />);
  state.persona = "Newest saved identity";
  view.rerender(<SidebarLeadIdentitySheet visible onClose={close} />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Newest saved identity");
});

it("wraps the host subtitle in themed Text rather than a raw View text node", () => {
  render(<SidebarLeadIdentitySheet visible onClose={vi.fn()} />);
  const subtitle = screen.getByTestId("identity-subtitle");
  expect(subtitle.textContent).toBe("Mac");
  expect(subtitle.firstChild?.nodeType).toBe(Node.ELEMENT_NODE);
  expect(getComputedStyle(subtitle.firstElementChild!).color).not.toBe("rgb(0, 0, 0)");
});
