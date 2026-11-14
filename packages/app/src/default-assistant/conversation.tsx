import { validateAssistantConversation } from "./conversation-model";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AssistantConversation } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useRetainedPanelActive } from "@/components/retained-panel";

export const ASSISTANT_CONVERSATION_QUERY_ROOT = "assistantLogicalConversation";

/** Presentation reads must not replace the shared fetching query's options. */
export function useCachedAssistantConversation(serverId: string, agentId: string) {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey;
        if (
          key.length === 3 &&
          key[0] === ASSISTANT_CONVERSATION_QUERY_ROOT &&
          key[1] === serverId &&
          key[2] === agentId
        )
          onChange();
      }),
    [queryClient, serverId, agentId],
  );
  const getSnapshot = useCallback(
    () =>
      queryClient.getQueryData<AssistantConversation>([
        ASSISTANT_CONVERSATION_QUERY_ROOT,
        serverId,
        agentId,
      ]),
    [queryClient, serverId, agentId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export async function cacheAssistantConversation(
  queryClient: QueryClient,
  serverId: string,
  conversation: AssistantConversation,
) {
  await queryClient.cancelQueries({ queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId] });
  for (const segment of conversation.segments) {
    queryClient.setQueryData(
      [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId, segment.agentId],
      conversation,
    );
  }
}

const ConversationContext = createContext<AssistantConversation | null>(null);
export const AssistantConversationProvider = ConversationContext.Provider;
export function useAssistantConversationContext() {
  return useContext(ConversationContext);
}

export function useAssistantConversation(serverId: string, agentId: string | undefined) {
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "defaultAssistantConversations");
  const active = useRetainedPanelActive();
  const classification = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = agentId
      ? (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))
      : null;
    if (!agent) return "unknown";
    return agent.labels?.["paseo.role"] === "assistant" ? "manager" : "other";
  });
  const enabled = Boolean(client && supported && classification !== "other" && agentId);
  const queryClient = useQueryClient();
  const query = useFetchQuery({
    queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId, agentId],
    queryFn: async () => {
      if (!client || !agentId) throw new Error("Assistant host unavailable");
      const result = await client.getDefaultAssistantConversation({ agentId });
      if (result.error) throw new Error(result.error);
      validateAssistantConversation(result.conversation);
      return result.conversation;
    },
    enabled: enabled && active,
    dataShape: "value",
    staleTimeMs: 1_000,
    retry: false,
  });
  useEffect(() => {
    if (!client || !enabled || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.on("agent_update", (event) => {
      if (
        event.payload.kind !== "upsert" ||
        event.payload.agent.labels?.["paseo.role"] !== "assistant"
      )
        return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId],
        });
      }, 150);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [active, client, enabled, queryClient, serverId]);
  return { ...query, enabled, required: classification === "manager" };
}

/** Workspace tabs retain the root anchor; subscribe separately to the live native segment. */
export function useViewedAssistantSegment(
  serverId: string,
  tabId: string,
  agentId: string | undefined,
) {
  const active = useRetainedPanelActive();
  const sync = useSessionStore((state) => state.sessions[serverId]?.viewedTimelineSync ?? null);
  const sourceId = `assistant-active:${tabId}`;
  useEffect(() => {
    if (!active || !agentId) return;
    void getHostRuntimeStore()
      .prepareAgentTimeline(serverId, agentId)
      .catch(() => undefined);
  }, [active, agentId, serverId]);
  useLayoutEffect(() => {
    if (!sync || !active || !agentId) return;
    sync.replaceVisibleAgentIds(sourceId, [agentId]);
    return () => sync.replaceVisibleAgentIds(sourceId, []);
  }, [active, agentId, sourceId, sync]);
}
