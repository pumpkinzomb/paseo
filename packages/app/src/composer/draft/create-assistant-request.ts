import type {
  CreateAgentRequestOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

/** User-created conversations always use the assistant lifecycle, never native fallback. */
export async function requestWorkspaceAssistant(
  client: Pick<DaemonClient, "ensureDefaultAssistant" | "sendMessage">,
  request: CreateAgentRequestOptions,
): Promise<AgentSnapshotPayload> {
  if (!request.workspaceId || !request.config || !request.idempotencyKey) {
    throw new Error("Assistant creation requires a workspace, config and stable draft identity.");
  }
  if (!request.clientMessageId) {
    throw new Error("Assistant submission requires a stable message identity.");
  }
  const config = request.config;
  const response = await client.ensureDefaultAssistant({
    newSession: true,
    requestId: request.idempotencyKey,
    workspaceId: request.workspaceId,
    provider: config.provider,
    model: config.model,
    thinkingOptionId: config.thinkingOptionId,
    modeId: config.modeId,
    providerOptions: config.providerOptions,
    cwd: config.cwd,
    metadata: request.metadata,
  });
  if (response.error || !response.agent) {
    throw new Error(response.error ?? "Assistant creation returned no agent.");
  }
  if (request.initialPrompt || request.images?.length || request.attachments?.length) {
    await client.sendMessage(response.agent.id, request.initialPrompt ?? "", {
      messageId: request.clientMessageId,
      images: request.images,
      attachments: request.attachments,
    });
  }
  return response.agent;
}
