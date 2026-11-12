import React, { useCallback } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantComposerModelSwitch, useAssistantModelSwitch } from "./composer-model-switch";

const mocks = vi.hoisted(() => ({
  setModel: vi.fn(),
  error: vi.fn(),
  status: "idle",
  role: "assistant",
  runtime: "legacy-unisolated",
  supported: true,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ setAgentModel: mocks.setModel }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => mocks.supported }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: mocks.error }) }));
vi.mock("@/hooks/use-providers-snapshot", () => ({ useProvidersSnapshot: () => ({}) }));
vi.mock("./handoff-source", () => ({ AssistantHandoffSource: () => null }));
vi.mock("./handoff-preview", () => ({
  AssistantHandoffPreview: ({
    selection,
    purpose,
    onClose,
  }: {
    selection: { provider: string };
    purpose?: string;
    onClose: () => void;
  }) => (
    <button type="button" onClick={onClose}>
      preview:{selection.provider}:{purpose ?? "model"}
    </button>
  ),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/session-store", () => {
  const getState = () => ({
    sessions: {
      fake: {
        agents: new Map([
          [
            "lead",
            {
              provider: "codex",
              model: "gpt-test",
              labels: { "paseo.role": mocks.role },
              runtimeInfo: { extra: { paseoLeadRuntimeStatus: mocks.runtime } },
              status: mocks.status,
              turn: { phase: "idle" },
              pendingPermissions: [],
            },
          ],
        ]),
      },
    },
  });
  return {
    useSessionStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState },
    ),
  };
});
function Choices() {
  const manager = useAssistantModelSwitch();
  const codex = useCallback(
    () => manager?.select({ provider: "codex", model: "gpt-next" }),
    [manager],
  );
  const claude = useCallback(
    () => manager?.select({ provider: "claude", model: "claude-next" }),
    [manager],
  );
  return (
    <>
      <button type="button" onClick={codex}>
        codex
      </button>
      <button type="button" onClick={claude}>
        claude
      </button>
    </>
  );
}
function show() {
  return render(
    <AssistantComposerModelSwitch serverId="fake" agentId="lead">
      <Choices />
    </AssistantComposerModelSwitch>,
  );
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  mocks.status = "idle";
  mocks.role = "assistant";
  mocks.runtime = "legacy-unisolated";
  mocks.supported = true;
  mocks.setModel.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
});
afterEach(cleanup);
describe("lead migration entry", () => {
  it("opens a reviewed same-provider successor, not an in-place setting change", () => {
    show();
    fireEvent.click(screen.getByText("defaultAssistant.isolationAction"));
    expect(screen.getByText("preview:codex:isolation")).toBeTruthy();
    expect(mocks.setModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("preview:codex:isolation"));
    expect(screen.queryByText("preview:codex:isolation")).toBeNull();
    expect(mocks.setModel).not.toHaveBeenCalled();
  });
  it("routes legacy model selection to review, and another provider still gets its own review", () => {
    show();
    fireEvent.click(screen.getByText("codex"));
    expect(screen.getByText("preview:codex:isolation")).toBeTruthy();
    fireEvent.click(screen.getByText("preview:codex:isolation"));
    fireEvent.click(screen.getByText("claude"));
    expect(screen.getByText("preview:claude:model")).toBeTruthy();
    expect(mocks.setModel).not.toHaveBeenCalled();
  });
  it("never migrates automatically on render and waits for active work", () => {
    mocks.status = "running";
    show();
    expect(screen.queryByText("preview:codex:isolation")).toBeNull();
    fireEvent.click(screen.getByText("defaultAssistant.isolationAction"));
    expect(mocks.error).toHaveBeenCalledWith("defaultAssistant.handoffWaitIdle");
    expect(screen.queryByText("preview:codex:isolation")).toBeNull();
  });
  it("retains same-provider in-place changes after isolation", async () => {
    mocks.runtime = "isolated";
    show();
    expect(screen.queryByText("defaultAssistant.isolationAction")).toBeNull();
    fireEvent.click(screen.getByText("codex"));
    await waitFor(() => expect(mocks.setModel).toHaveBeenCalledWith("lead", "gpt-next"));
  });
  it("does not expose lead migration for workers or unsupported hosts", () => {
    mocks.role = "worker";
    show();
    expect(screen.queryByText("defaultAssistant.isolationAction")).toBeNull();
    cleanup();
    mocks.role = "assistant";
    mocks.supported = false;
    show();
    expect(screen.queryByText("defaultAssistant.isolationAction")).toBeNull();
  });
});
