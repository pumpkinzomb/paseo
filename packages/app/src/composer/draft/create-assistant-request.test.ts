import { describe, expect, it, vi } from "vitest";
import type {
  DaemonClient,
  CreateAgentRequestOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { requestWorkspaceAssistant } from "./create-assistant-request";

const agent: AgentSnapshotPayload = {
  id: "assistant-1",
  provider: "codex",
  cwd: "/project",
  model: null,
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Assistant",
  labels: { "paseo.role": "assistant" },
};
const request: CreateAgentRequestOptions = {
  workspaceId: "project-workspace",
  idempotencyKey: "draft-1",
  clientMessageId: "message-1",
  config: {
    provider: "codex",
    cwd: "/project/subdir",
    model: "model",
    thinkingOptionId: "high",
    modeId: "default",
    providerOptions: { option: true },
  },
  metadata: { source: "draft" },
  initialPrompt: "Build this",
  images: [{ data: "test-image", mimeType: "image/png" }],
  attachments: [{ type: "text", mimeType: "text/plain", text: "prior context", title: "History" }],
};
function client() {
  return {
    ensureDefaultAssistant: vi.fn<DaemonClient["ensureDefaultAssistant"]>().mockResolvedValue({
      requestId: "draft-1",
      agent,
      workspace: null,
      conversation: undefined,
      error: null,
    }),
    sendMessage: vi.fn<DaemonClient["sendMessage"]>().mockResolvedValue({}),
  };
}
describe("user conversation creation", () => {
  it("creates an assistant in its workspace and preserves selected settings and message payload", async () => {
    const rpc = client();
    expect(await requestWorkspaceAssistant(rpc, request)).toBe(agent);
    expect(rpc.ensureDefaultAssistant).toHaveBeenCalledWith({
      newSession: true,
      requestId: "draft-1",
      workspaceId: "project-workspace",
      provider: "codex",
      model: "model",
      thinkingOptionId: "high",
      modeId: "default",
      providerOptions: { option: true },
      cwd: "/project/subdir",
      metadata: { source: "draft" },
    });
    expect(rpc.sendMessage).toHaveBeenCalledWith("assistant-1", "Build this", {
      messageId: "message-1",
      images: request.images,
      attachments: request.attachments,
    });
  });
  it("does not send or fall back to ordinary creation on unsupported hosts", async () => {
    const rpc = client();
    rpc.ensureDefaultAssistant.mockRejectedValue(new Error("Update this host"));
    await expect(requestWorkspaceAssistant(rpc, request)).rejects.toThrow("Update this host");
    expect(rpc.sendMessage).not.toHaveBeenCalled();
  });
  it("retries send with the same creation and message identities after a disconnected acknowledgement", async () => {
    const rpc = client();
    rpc.sendMessage.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(requestWorkspaceAssistant(rpc, request)).rejects.toThrow("Disconnected");
    await expect(requestWorkspaceAssistant(rpc, request)).resolves.toBe(agent);
    expect(rpc.ensureDefaultAssistant.mock.calls.map(([arg]) => arg?.requestId)).toEqual([
      "draft-1",
      "draft-1",
    ]);
    expect(rpc.sendMessage.mock.calls.map((args) => args[2]?.messageId)).toEqual([
      "message-1",
      "message-1",
    ]);
  });
  it("keeps image-only messages and does not run an empty conversation", async () => {
    const rpc = client();
    await requestWorkspaceAssistant(rpc, { ...request, initialPrompt: "" });
    expect(rpc.sendMessage.mock.calls[0]?.[1]).toBe("");
    expect(rpc.sendMessage.mock.calls[0]?.[2]?.images).toEqual(request.images);
    rpc.sendMessage.mockClear();
    await requestWorkspaceAssistant(rpc, {
      ...request,
      initialPrompt: "",
      images: [],
      attachments: [],
    });
    expect(rpc.sendMessage).not.toHaveBeenCalled();
  });
  it("exposes server rejection and malformed draft identity without sending", async () => {
    const rpc = client();
    rpc.ensureDefaultAssistant.mockResolvedValue({
      requestId: "draft-1",
      agent: null,
      workspace: null,
      conversation: undefined,
      error: "Workspace archived",
    });
    await expect(requestWorkspaceAssistant(rpc, request)).rejects.toThrow("Workspace archived");
    await expect(
      requestWorkspaceAssistant(rpc, { ...request, idempotencyKey: undefined }),
    ).rejects.toThrow("stable draft identity");
    expect(rpc.sendMessage).not.toHaveBeenCalled();
  });
});
