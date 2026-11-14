import type { AssistantConversation } from "@getpaseo/protocol/messages";
import { useReplicaQuery } from "@/data/query";
import { ASSISTANT_CONVERSATION_QUERY_ROOT } from "@/default-assistant/conversation";
import { MessageCircle } from "lucide-react-native";
import { useShallow } from "zustand/shallow";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import { useProviderIcon } from "@/components/provider-icons";
import type { PanelDescriptor } from "@/panels/panel-registry";
import {
  useSessionStore,
  selectAgentTurnPresentation,
  type Agent,
  type SessionState,
} from "@/stores/session-store";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

function isAssistantAgent(agent: Agent | null): boolean {
  return agent?.labels?.["paseo.role"] === "assistant";
}

// Titles the daemon stores for the lead agent: DEFAULT_ASSISTANT_DISPLAY_NAME in
// packages/server/src/server/default-assistant/index.ts and its pre-rename value.
// Stored titles are not localized, so the client shows its own translation instead.
const DEFAULT_ASSISTANT_STORED_TITLES = new Set(["Lead agent", "Assistant"]);

/** Canonical anchor suffixes survive tab closure and provider switches without renaming native history. */
export function resolveAssistantTitle(
  title: string | null | undefined,
  createdAt?: Date | null,
  anchorId?: string,
): string {
  const label = resolveAgentLabel(title);
  if (label !== null && !DEFAULT_ASSISTANT_STORED_TITLES.has(label)) return label;
  const name = i18n.t("defaultAssistant.title");
  if (anchorId) return `${name} · ${anchorId.slice(-6)}`;
  return createdAt ? `${name} · ${createdAt.toLocaleString(i18n.language)}` : name;
}

function formatProviderLabel(provider: Agent["provider"]): string {
  if (!provider) {
    return "Agent";
  }
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveAgentLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export function useAgentDescriptor(
  target: { kind: "agent"; agentId: string },
  context: { serverId: string },
): PanelDescriptor {
  useTranslation();
  const { data: conversation } = useReplicaQuery<AssistantConversation>({
    queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, context.serverId, target.agentId],
    pushEvent: "agent_update",
    enabled: false,
  });
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[context.serverId];
      const anchorId = conversation?.segments[0]?.agentId ?? target.agentId;
      const agent = findDescriptorAgent(session, anchorId);
      const statusId = isAssistantAgent(agent) ? conversation?.activeAgentId : target.agentId;
      const current = findDescriptorAgent(session, statusId);
      return {
        provider: agent?.provider ?? "codex",
        isAssistant: isAssistantAgent(agent),
        title: agent?.title ?? null,
        createdAt: agent && agent.createdAt,
        ...agentStatusAttributes(
          current ?? null,
          selectAgentTurnPresentation(session, statusId ?? "").isActive,
        ),
      };
    }),
  );
  const icon = useProviderIcon(descriptorState.provider, context.serverId);
  const descriptor = buildAgentDescriptor({
    ...descriptorState,
    title: descriptorState.isAssistant
      ? resolveAssistantTitle(
          descriptorState.title,
          descriptorState.createdAt,
          conversation?.segments[0]?.agentId ?? target.agentId,
        )
      : descriptorState.title,
    icon: descriptorState.isAssistant ? MessageCircle : icon,
  });
  return descriptorState.isAssistant
    ? {
        ...descriptor,
        subtitle: i18n.t("defaultAssistant.title"),
        tooltip: `${descriptor.label} · ${descriptorState.createdAt?.toISOString() ?? ""} · ${target.agentId}`,
      }
    : descriptor;
}

function findDescriptorAgent(session: SessionState | undefined, agentId: string | undefined) {
  return agentId
    ? (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null)
    : null;
}

function agentStatusAttributes(current: Agent | null, isTurnActive: boolean) {
  return {
    status: current?.status ?? null,
    backgroundWork: current?.backgroundWork,
    pendingPermissionCount: current?.pendingPermissions.length ?? 0,
    requiresAttention: current?.requiresAttention ?? false,
    attentionReason: current?.attentionReason ?? null,
    isTurnActive,
  };
}

export function buildAgentDescriptor(input: {
  provider: Agent["provider"];
  title: string | null;
  status: Agent["status"] | null;
  backgroundWork?: Agent["backgroundWork"];
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"];
  isTurnActive: boolean;
  icon: PanelDescriptor["icon"];
}): PanelDescriptor {
  const provider = input.provider;
  const label = resolveAgentLabel(input.title);
  const statusBucket = input.status
    ? deriveSidebarStateBucket({
        status: input.isTurnActive ? "running" : input.status,
        backgroundWork: input.backgroundWork,
        pendingPermissionCount: input.pendingPermissionCount,
        requiresAttention: input.requiresAttention,
        attentionReason: input.attentionReason,
      })
    : null;

  return {
    label: label ?? "",
    subtitle:
      statusBucket === "running" && !input.isTurnActive && input.status !== "running"
        ? i18n.t("message.backgroundWork.running")
        : `${formatProviderLabel(provider)} agent`,
    tooltip: label ?? `${formatProviderLabel(provider)} agent`,
    titleState: label ? "ready" : "loading",
    icon: input.icon,
    statusBucket,
  };
}
