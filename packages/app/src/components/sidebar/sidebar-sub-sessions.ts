import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";

/**
 * Sub-sessions are workspaces an agent created for its own work (`parentWorkspaceId`). Project
 * mode draws them under the session that created them instead of as rows of their own project,
 * so a parent's helpers never also appear as separate top-level work.
 */
export interface SidebarSubSessionNesting {
  projects: SidebarProjectEntry[];
  /** Nested placements keyed by the parent row's `workspaceKey`, in project order. */
  childrenByParentKey: ReadonlyMap<string, readonly SidebarWorkspacePlacement[]>;
}

export interface SidebarSubSessionGroups {
  /** Sub-sessions with live work or something for the user to look at. */
  active: SidebarWorkspacePlacement[];
  /** Sub-sessions whose agents have finished; shown collapsed under "Done". */
  done: SidebarWorkspacePlacement[];
}

const EMPTY_CHILDREN = new Map<string, readonly SidebarWorkspacePlacement[]>();

/** Only a resolved assistant room uses conversation-only navigation. Unknown inventory stays visible. */
export function isRoomSessionWorkspaceVisible(input: {
  hasLeads: boolean;
  sessionCount: number | undefined;
  hasAgentEvidence: boolean;
}): boolean {
  return !input.hasLeads || input.sessionCount !== 0 || input.hasAgentEvidence;
}

/**
 * Maps each visible sub-session to the visible root session it nests under. Nesting is one
 * level deep: a sub-session of a sub-session joins the same root. A parent that is hidden,
 * archived, pinned, or on another host leaves the child in its own project, so filtering
 * never makes work disappear. Cycles nest nothing.
 */
export function resolveSubSessionRootKeys(input: {
  entries: Iterable<SidebarWorkspaceEntry>;
  pinnedWorkspaceKeys?: ReadonlySet<string>;
}): Map<string, string> {
  const pinned = input.pinnedWorkspaceKeys;
  const parentKeyByKey = new Map<string, string | null>();
  for (const entry of input.entries) {
    parentKeyByKey.set(
      entry.workspaceKey,
      entry.parentWorkspaceId ? `${entry.serverId}:${entry.parentWorkspaceId}` : null,
    );
  }

  const rootKeyByChildKey = new Map<string, string>();
  for (const [childKey, directParentKey] of parentKeyByKey) {
    if (!directParentKey || pinned?.has(childKey)) continue;
    const visited = new Set([childKey]);
    let rootKey: string | null = null;
    let candidate: string | null = directParentKey;
    while (candidate && parentKeyByKey.has(candidate) && !pinned?.has(candidate)) {
      if (visited.has(candidate)) {
        rootKey = null;
        break;
      }
      visited.add(candidate);
      rootKey = candidate;
      candidate = parentKeyByKey.get(candidate) ?? null;
    }
    if (rootKey) rootKeyByChildKey.set(childKey, rootKey);
  }
  return rootKeyByChildKey;
}

export function areSubSessionRootKeysEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [childKey, rootKey] of left) {
    if (right.get(childKey) !== rootKey) return false;
  }
  return true;
}

/**
 * Moves sub-sessions out of their projects. A project whose every workspace became a sub-session
 * is dropped: it exists only because a parent placed work there. A project that never had a
 * workspace keeps its header so the user can still start one.
 */
export function nestSubSessions(input: {
  projects: SidebarProjectEntry[];
  rootKeyByChildKey: ReadonlyMap<string, string>;
}): SidebarSubSessionNesting {
  if (input.rootKeyByChildKey.size === 0) {
    return { projects: input.projects, childrenByParentKey: EMPTY_CHILDREN };
  }
  const childrenByParentKey = new Map<string, SidebarWorkspacePlacement[]>();
  const projects: SidebarProjectEntry[] = [];
  for (const project of input.projects) {
    const kept: SidebarWorkspacePlacement[] = [];
    for (const workspace of project.workspaces) {
      const rootKey = input.rootKeyByChildKey.get(workspace.workspaceKey);
      if (!rootKey) {
        kept.push(workspace);
        continue;
      }
      const siblings = childrenByParentKey.get(rootKey);
      if (siblings) siblings.push(workspace);
      else childrenByParentKey.set(rootKey, [workspace]);
    }
    if (kept.length === project.workspaces.length) projects.push(project);
    else if (kept.length > 0) projects.push({ ...project, workspaces: kept });
  }
  return { projects, childrenByParentKey };
}

export function groupSubSessionsByActivity(input: {
  children: readonly SidebarWorkspacePlacement[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
}): SidebarSubSessionGroups {
  const active: SidebarWorkspacePlacement[] = [];
  const done: SidebarWorkspacePlacement[] = [];
  for (const child of input.children) {
    const entry = input.workspaceEntriesByKey.get(child.workspaceKey);
    if (entry?.statusBucket === "done" && (entry.sessionCount ?? 0) > 0) done.push(child);
    else active.push(child);
  }
  return { active, done };
}

/** A room has many independent leads. Only recorded same-host creator evidence can
 * place a workspace under one; no-agent/unknown inventory never establishes completion.
 */
export function partitionRoomWork<
  T extends { creatorAgent?: { serverId: string; agentId: string } },
>(
  serverId: string,
  conversations: readonly { logicalId: string; segments: readonly { agentId: string }[] }[],
  items: readonly T[],
): { byLead: Map<string, T[]>; unassigned: T[] } {
  const owners = new Map<string, string | null>();
  for (const conversation of conversations) {
    for (const segment of conversation.segments) {
      const previous = owners.get(segment.agentId);
      owners.set(
        segment.agentId,
        owners.has(segment.agentId) && previous !== conversation.logicalId
          ? null
          : conversation.logicalId,
      );
    }
  }
  const byLead = new Map<string, T[]>();
  const unassigned: T[] = [];
  for (const item of items) {
    const creator = item.creatorAgent;
    const owner = creator?.serverId === serverId ? owners.get(creator.agentId) : null;
    if (!owner) unassigned.push(item);
    else {
      const siblings = byLead.get(owner) ?? [];
      siblings.push(item);
      byLead.set(owner, siblings);
    }
  }
  return { byLead, unassigned };
}

export function leadCollapseKey(serverId: string, workspaceId: string, logicalId: string) {
  return JSON.stringify(["room-lead", serverId, workspaceId, logicalId]);
}
