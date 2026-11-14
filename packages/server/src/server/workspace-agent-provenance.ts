import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";

interface RecordEvidence {
  id: string;
  labels?: Record<string, string>;
  internal?: boolean;
  background?: boolean;
}

/** Storage passes the complete exact-workspace inventory, including archived records.
 * Legacy parent labels can recover ownership; an unparented root or conflicting external
 * parents cannot. Never rewrite a durable creator from mutable agent labels.
 */
export function workspaceAgentProvenance(
  serverId: string | undefined,
  creator: AgentAddress | undefined,
  records: readonly RecordEvidence[],
): { creatorAgent?: AgentAddress; sessionCount: number } {
  if (!serverId)
    return { sessionCount: records.filter((agent) => !agent.internal && !agent.background).length };
  const visible = records.filter((agent) => !agent.internal && !agent.background);
  const byId = new Map(records.map((agent) => [agent.id, agent]));
  const externalParents = visible.map((agent) => {
    let current = agent;
    const visited = new Set<string>();
    while (!visited.has(current.id)) {
      visited.add(current.id);
      const parent = getParentAddressFromLabels(current.labels, serverId);
      if (!parent || parent.serverId !== serverId || !byId.has(parent.agentId)) return parent;
      current = byId.get(parent.agentId)!;
    }
    return null;
  });
  const first = creator ?? externalParents.find((parent) => parent !== null);
  const unambiguous =
    first?.serverId === serverId &&
    externalParents.every(
      (parent) => parent?.serverId === first.serverId && parent.agentId === first.agentId,
    );
  return {
    sessionCount: visible.length,
    ...(first && unambiguous ? { creatorAgent: first } : {}),
  };
}
