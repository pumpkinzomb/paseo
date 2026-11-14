import { createHash } from "node:crypto";
import type { AssistantConversation, WorkspaceLeadAssociation } from "@getpaseo/protocol/messages";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

export interface TaskParentRecord {
  id: string;
  workspaceId?: string;
  labels: Record<string, string>;
}
export interface TaskOwnership {
  lead: WorkspaceLeadAssociation;
  proof: "creator-and-parent-evidence" | "reviewed-legacy-intent";
  revision: string;
}
interface Ports {
  serverId: string;
  getAgent(id: string): Promise<TaskParentRecord | null>;
  leadForAgent(agent: TaskParentRecord): Promise<WorkspaceLeadAssociation | undefined>;
  canonical(lead: WorkspaceLeadAssociation): Promise<AssistantConversation>;
}
function same(a: WorkspaceLeadAssociation, b: WorkspaceLeadAssociation) {
  return (
    a.serverId === b.serverId &&
    a.roomWorkspaceId === b.roomWorkspaceId &&
    a.logicalId === b.logicalId &&
    a.anchorAgentId === b.anchorAgentId
  );
}

/** Parent labels are mutable corroboration, never a grant to retire a workspace. */
export async function resolveTaskOwnership(
  record: PersistedWorkspaceRecord,
  agents: readonly TaskParentRecord[],
  ports: Ports,
): Promise<TaskOwnership> {
  if (!agents.length || agents.length > 256)
    throw new Error("Task parent inventory is empty or exceeds the review bound");
  if (!record.creatorAgent && (!record.leadAssociation || record.workspacePurpose !== "task"))
    throw new Error(
      "Legacy task ownership review required: declare its lead and task purpose through the host-managed inspect/apply operation",
    );
  if (record.creatorAgent && record.creatorAgent.serverId !== ports.serverId)
    throw new Error("Task creator belongs to another host");
  const creator = record.creatorAgent ? await ports.getAgent(record.creatorAgent.agentId) : null;
  const creatorLead = creator ? await ports.leadForAgent(creator) : undefined;
  if (record.creatorAgent && !creatorLead) throw new Error("Task creator authority unavailable");
  const lead = record.leadAssociation ?? creatorLead;
  if (!lead || lead.serverId !== ports.serverId || (creatorLead && !same(creatorLead, lead)))
    throw new Error("Task declared owner contradicts creator authority");
  const conversation = await ports.canonical(lead);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const evidence = new Map<string, TaskParentRecord>();
  const roots = new Set(conversation.segments.map((segment) => segment.agentId));
  const roomWorkspaceId = lead.roomWorkspaceId;
  async function trace(start: string) {
    let id: string | undefined = start;
    const seen = new Set<string>();
    while (id && !seen.has(id) && seen.size < 64) {
      seen.add(id);
      const agent: TaskParentRecord | null = byId.get(id) ?? (await ports.getAgent(id));
      if (!agent) throw new Error("Task parent evidence is missing");
      evidence.set(id, {
        id,
        workspaceId: agent.workspaceId,
        labels: {
          "paseo.role": agent.labels["paseo.role"] ?? "",
          "paseo.parent-agent-id": agent.labels["paseo.parent-agent-id"] ?? "",
          "paseo.parent-server-id": agent.labels["paseo.parent-server-id"] ?? "",
        },
      });
      const parent: string | undefined = agent.labels["paseo.parent-agent-id"];
      if (!parent) {
        if (
          roots.has(id) &&
          agent.workspaceId === roomWorkspaceId &&
          agent.labels["paseo.role"] === "assistant"
        )
          return;
        throw new Error("Task parent evidence has an unparented or conflicting root");
      }
      if (agent.labels["paseo.parent-server-id"] !== ports.serverId)
        throw new Error("Task parent evidence belongs to another host");
      id = parent;
    }
    throw new Error("Task parent evidence has a cycle or exceeds the bound");
  }
  for (const agent of agents) await trace(agent.id);
  if (creator) await trace(creator.id);
  const proof = record.creatorAgent ? "creator-and-parent-evidence" : "reviewed-legacy-intent";
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        lead,
        conversation,
        evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
  return { lead, proof, revision };
}
