import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostFeature } from "@/runtime/host-features";
import { useFetchQuery } from "@/data/query";
import { ASSISTANT_CONVERSATION_QUERY_ROOT } from "./conversation";
import { validateAssistantConversation } from "./conversation-model";
import { resolveRoomLeads, selectRoomLeadAgentIds } from "./room-leads";

/** One scoped query shared by every rendering of the room, backed by the existing segment cache. */
export function useRoomLeads(serverId: string, workspaceId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const active = useRetainedPanelActive();
  const supported = useHostFeature(serverId, "defaultAssistantConversations");
  const queryClient = useQueryClient();
  const ids = useSessionStore(
    useShallow((state) =>
      selectRoomLeadAgentIds(state.sessions[serverId]?.agents.values() ?? [], workspaceId),
    ),
  );
  const available = Boolean(supported && ids.length);
  const enabled = Boolean(client && connected && active && available);
  const query = useFetchQuery({
    queryKey: ["roomLeads", serverId, workspaceId, ids],
    queryFn: () =>
      resolveRoomLeads(workspaceId, ids, async (agentId) => {
        const conversation = await queryClient.fetchQuery({
          queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId, agentId],
          queryFn: async () => {
            if (!client) throw new Error("Assistant host unavailable");
            const result = await client.getDefaultAssistantConversation({ agentId });
            if (result.error) throw new Error(result.error);
            if (!result.conversation) throw new Error("Assistant conversation unavailable");
            validateAssistantConversation(result.conversation);
            return result.conversation;
          },
          staleTime: 0,
        });
        for (const segment of conversation.segments) {
          queryClient.setQueryData(
            [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId, segment.agentId],
            conversation,
          );
        }
        return conversation;
      }),
    enabled,
    dataShape: "value",
    staleTimeMs: 1_000,
    retry: false,
  });
  useEffect(() => {
    if (!client || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.on("agent_update", (event) => {
      if (
        event.payload.kind === "upsert" &&
        (event.payload.agent.workspaceId !== workspaceId ||
          event.payload.agent.labels?.["paseo.role"] !== "assistant")
      )
        return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshRoomLeadQueries(queryClient, serverId, workspaceId);
      }, 150);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [client, enabled, queryClient, serverId, workspaceId]);
  return { ...query, enabled, available, connected };
}

async function refreshRoomLeadQueries(
  queryClient: QueryClient,
  serverId: string,
  workspaceId: string,
) {
  await queryClient.invalidateQueries({
    queryKey: [ASSISTANT_CONVERSATION_QUERY_ROOT, serverId],
    refetchType: "none",
  });
  await queryClient.invalidateQueries({ queryKey: ["roomLeads", serverId, workspaceId] });
}
