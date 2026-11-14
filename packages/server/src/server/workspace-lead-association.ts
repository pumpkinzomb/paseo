import { createHash, randomUUID } from "node:crypto";
import type {
  AssistantConversation,
  WorkspaceLeadAssociation,
  WorkspaceLeadAssociationAssignment,
  WorkspaceLeadAssociationPreview,
  WorkspacePurpose,
  WorkspaceHistoryScope,
} from "@getpaseo/protocol/messages";
import type { WorkspaceRegistry, PersistedWorkspaceRecord } from "./workspace-registry.js";

export interface LeadAssociationAgent {
  id: string;
  workspaceId?: string;
  labels: Record<string, string>;
  archivedAt?: string | null;
  background?: boolean;
  internal?: boolean;
  title?: string | null;
}
interface Dependencies {
  serverId: string;
  registry: WorkspaceRegistry;
  withWorkspaceLock?<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
  getAgent(id: string): Promise<LeadAssociationAgent | null>;
  getConversation(input: {
    logicalId?: string;
    agentId?: string;
  }): Promise<AssistantConversation | null>;
  listAgents(ids: string[]): Promise<LeadAssociationAgent[]>;
}
function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value ?? null, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}
export const workspaceEvidenceRevision = (
  record: PersistedWorkspaceRecord,
  agents: readonly unknown[],
  ancestors: readonly PersistedWorkspaceRecord[] = [],
) => digest({ record, agents, ancestors });
export function workspaceRoomAncestry(
  records: ReadonlyMap<string, PersistedWorkspaceRecord>,
  id: string,
  room: string,
): PersistedWorkspaceRecord[] {
  const result: PersistedWorkspaceRecord[] = [],
    seen = new Set<string>();
  let next: string | undefined = id;
  while (next && !seen.has(next)) {
    seen.add(next);
    const record = records.get(next);
    if (!record) break;
    result.push(record);
    if (next === room) {
      if (id === room || record.archivedAt) break;
      return result;
    }
    next = record.parentWorkspaceId;
  }
  throw new Error("Workspace is not a child of the active room");
}
function assertAvailableLead(
  active: LeadAssociationAgent | null,
  roomWorkspaceId: string,
): asserts active is LeadAssociationAgent {
  if (
    !active ||
    active.archivedAt ||
    active.background ||
    active.internal ||
    active.workspaceId !== roomWorkspaceId ||
    active.labels["paseo.role"] !== "assistant" ||
    active.labels["paseo.parent-agent-id"]
  )
    throw new Error("Target lead is unavailable");
}
export function validateWorkspaceItemScope(
  serverId: string | undefined,
  records: readonly PersistedWorkspaceRecord[],
  workspaceId: string,
  workspaceIds: readonly string[],
  scope: WorkspaceHistoryScope,
) {
  const room = records.find((r) => r.workspaceId === scope.roomWorkspaceId);
  if (!serverId || !room || room.archivedAt) throw new Error("Workspace history room unavailable");
  const record = records.find((r) => r.workspaceId === workspaceId);
  if (
    !record ||
    workspaceIds.length !== 1 ||
    workspaceIds[0] !== record.workspaceId ||
    (scope.leadAssociation && scope.leadAssociation.serverId !== serverId) ||
    digest(record.leadAssociation) !== digest(scope.leadAssociation)
  )
    throw new Error("Workspace history ownership changed. Reopen Remove record.");
  if (scope.itemKind === "planned") {
    if (record.workspacePurpose !== "planned")
      throw new Error("Workspace history ownership changed. Reopen Remove record.");
  } else if (scope.itemKind !== "session" && !record.archivedAt)
    throw new Error("Workspace history ownership changed. Reopen Remove record.");
  if (
    record.workspacePurpose === "source" ||
    records.some((r) => r.developmentSourceIds?.includes(record.workspaceId))
  )
    throw new Error("Retained source workspaces cannot be removed as history.");
  const chain = workspaceRoomAncestry(
    new Map(records.map((r) => [r.workspaceId, r])),
    record.workspaceId,
    scope.roomWorkspaceId,
  );
  return { record, chain };
}

export class WorkspaceLeadAssociations {
  private previews = new Map<
    string,
    {
      principal: object;
      expires: number;
      room: string;
      assignments: readonly WorkspaceLeadAssociationAssignment[];
      revision: string;
    }
  >();
  constructor(private deps: Dependencies) {}

  async canonical(lead: WorkspaceLeadAssociation) {
    if (lead.serverId !== this.deps.serverId) throw new Error("Lead belongs to another host");
    const room = await this.deps.registry.get(lead.roomWorkspaceId);
    if (!room || room.archivedAt || room.background) throw new Error("Lead room is unavailable");
    const conversation = await this.deps.getConversation({ logicalId: lead.logicalId });
    if (
      !conversation ||
      conversation.segments[0]?.agentId !== lead.anchorAgentId ||
      conversation.segments[0]?.workspaceId !== lead.roomWorkspaceId ||
      conversation.activeWorkspaceId !== lead.roomWorkspaceId
    )
      throw new Error("Lead identity or room changed");
    const active = await this.deps.getAgent(conversation.activeAgentId);
    assertAvailableLead(active, lead.roomWorkspaceId);
    const anchor = await this.deps.getAgent(lead.anchorAgentId);
    return { conversation, name: anchor?.title || active.title || "Lead agent" };
  }

  /** Internal authenticated caller context only; never accept a wire callerAgentId here. */
  async forCaller(
    agentId: string,
    callerWorkspaceId: string,
  ): Promise<WorkspaceLeadAssociation | undefined> {
    const seen = new Set<string>();
    let id: string | undefined = agentId;
    while (id && !seen.has(id) && seen.size < 64) {
      seen.add(id);
      const agent = await this.deps.getAgent(id);
      if (!agent || agent.archivedAt || agent.background || agent.internal) return;
      if (id === agentId && agent.workspaceId !== callerWorkspaceId)
        throw new Error("Caller workspace changed");
      if (id === agentId) {
        const workspace = await this.deps.registry.get(callerWorkspaceId);
        if (!workspace || workspace.archivedAt) throw new Error("Caller workspace unavailable");
        if (workspace.leadAssociation) {
          await this.canonical(workspace.leadAssociation);
          workspaceRoomAncestry(
            new Map((await this.deps.registry.listAll()).map((r) => [r.workspaceId, r])),
            callerWorkspaceId,
            workspace.leadAssociation.roomWorkspaceId,
          );
          return workspace.leadAssociation;
        }
      }
      const parent = agent.labels["paseo.parent-agent-id"];
      if (parent) {
        if (agent.labels["paseo.parent-server-id"] !== this.deps.serverId) return;
        id = parent;
        continue;
      }
      if (agent.labels["paseo.role"] !== "assistant" || !agent.workspaceId) return;
      const conversation = await this.deps.getConversation({ agentId: agent.id });
      if (!conversation) return;
      const lead = {
        serverId: this.deps.serverId,
        roomWorkspaceId: agent.workspaceId,
        logicalId: conversation.logicalId,
        anchorAgentId: conversation.segments[0]!.agentId,
      };
      await this.canonical(lead);
      return lead;
    }
  }

  private async evidence(
    records: ReadonlyMap<string, PersistedWorkspaceRecord>,
    room: string,
    assignments: readonly WorkspaceLeadAssociationAssignment[],
  ) {
    if (
      !assignments.length ||
      assignments.length > 20 ||
      new Set(assignments.map((a) => a.workspaceId)).size !== assignments.length
    )
      throw new Error("Invalid assignment batch");
    const output = [];
    for (const assignment of assignments) {
      if (assignment.lead.roomWorkspaceId !== room) throw new Error("Lead belongs to another room");
      const chain = workspaceRoomAncestry(records, assignment.workspaceId, room);
      const record = chain[0]!;
      if (record.leadAssociation && digest(record.leadAssociation) !== digest(assignment.lead))
        throw new Error("Workspace already has a different intended lead");
      if (record.workspacePurpose && record.workspacePurpose !== assignment.purpose)
        throw new Error("Workspace already has a different purpose");
      const target = await this.canonical(assignment.lead);
      const agents = (await this.deps.listAgents([record.workspaceId]))
        .filter((a) => !a.background && !a.internal)
        .sort((a, b) => a.id.localeCompare(b.id));
      // A migration does not silently relocate another lead's actual conversations.
      for (const agent of agents) {
        const parent = agent.labels["paseo.parent-agent-id"];
        if (
          parent &&
          (agent.labels["paseo.parent-server-id"] !== this.deps.serverId ||
            !target.conversation.segments.some((s) => s.agentId === parent))
        )
          throw new Error("Conversation parent evidence conflicts with the target lead");
      }
      const finalTarget = await this.canonical(assignment.lead);
      if (digest(finalTarget) !== digest(target))
        throw new Error("Lead changed during evidence read");
      output.push({
        assignment,
        chain,
        agents,
        conversation: target.conversation,
        leadName: target.name,
      });
    }
    return output;
  }

  async inspect(
    principal: object,
    room: string,
    assignments: readonly WorkspaceLeadAssociationAssignment[],
  ): Promise<Omit<WorkspaceLeadAssociationPreview, "requestId">> {
    const frozen = structuredClone(assignments);
    const records = new Map((await this.deps.registry.listAll()).map((r) => [r.workspaceId, r]));
    const evidence = await this.evidence(records, room, frozen);
    const now = Date.now();
    for (const [token, preview] of this.previews)
      if (preview.expires < now) this.previews.delete(token);
    if (this.previews.size >= 32) throw new Error("Too many pending ownership previews");
    const token = randomUUID(),
      expires = now + 5 * 60_000;
    this.previews.set(token, {
      principal,
      expires,
      room,
      assignments: frozen,
      revision: digest(evidence),
    });
    return {
      previewToken: token,
      expiresAt: new Date(expires).toISOString(),
      entries: evidence.map(({ assignment, chain, agents, leadName }) => ({
        workspaceId: assignment.workspaceId,
        name: chain[0]!.title || chain[0]!.displayName,
        lead: assignment.lead,
        purpose: assignment.purpose,
        leadName,
        archived: Boolean(chain[0]!.archivedAt),
        sessionCount: agents.length,
        revision: digest({ chain, agents }),
      })),
    };
  }

  async apply(principal: object, token: string, authorized: () => boolean): Promise<string[]> {
    const preview = this.previews.get(token);
    if (
      !preview ||
      preview.principal !== principal ||
      preview.expires < Date.now() ||
      !authorized()
    )
      throw new Error("Ownership preview expired or is not authorized");
    const commit = this.deps.registry.commitLeadAssociationMutation;
    if (!commit) throw new Error("Host does not support lead association transactions");
    let current!: ReadonlyMap<string, PersistedWorkspaceRecord>;
    const perform = () =>
      commit.call(
        this.deps.registry,
        (records) => {
          current = new Map(records);
          return preview.assignments.map((assignment) => {
            const record = records.get(assignment.workspaceId);
            if (!record) throw new Error("Workspace changed since preview");
            return {
              ...record,
              leadAssociation: assignment.lead,
              workspacePurpose: assignment.purpose,
              updatedAt: new Date().toISOString(),
            };
          });
        },
        async () => {
          const revision = digest(await this.evidence(current, preview.room, preview.assignments));
          if (!authorized() || preview.expires < Date.now() || revision !== preview.revision)
            throw new Error("Ownership evidence changed; inspect again");
        },
      );
    const ids = preview.assignments.map((a) => a.workspaceId).sort();
    const locked = (index: number): Promise<void> => {
      if (index === ids.length) return perform();
      if (this.deps.withWorkspaceLock)
        return this.deps.withWorkspaceLock(ids[index]!, () => locked(index + 1));
      return locked(index + 1);
    };
    await locked(0);
    this.previews.delete(token);
    return preview.assignments.map((a) => a.workspaceId);
  }

  async validateIntent(lead: WorkspaceLeadAssociation, purpose: WorkspacePurpose) {
    await this.canonical(lead);
    return { leadAssociation: lead, workspacePurpose: purpose };
  }
}
