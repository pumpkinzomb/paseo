import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { selectHostFeature } from "@/runtime/host-features";

interface ProjectRemoveHost {
  serverId: string;
  projectId: string;
}

export interface ProjectRemoveProject {
  hosts: readonly ProjectRemoveHost[];
}

export interface ProjectRemoveTarget {
  serverId: string;
  projectId: string;
}

export type ProjectRemoveReadiness =
  | { kind: "ready"; targets: ProjectRemoveTarget[] }
  | { kind: "needs_host_update"; serverIds: string[] }
  | { kind: "host_unavailable"; serverIds: string[] };

export type ProjectRemoveOutcome =
  | { kind: "removed"; serverIds: string[] }
  | { kind: "host_disconnected"; serverIds: string[] }
  | { kind: "failed"; serverIds: string[] };

export interface ProjectRemovalScope {
  workspaceIds: string[];
  agentIds: string[];
}
export interface InspectedProjectRemoveTarget extends ProjectRemoveTarget {
  deleteSessions: ProjectRemovalScope;
  deleteNativeSessions?: true;
}
type ProjectRemoveClient = Pick<DaemonClient, "removeProject">;

/** Inspect every host before presenting a destructive confirmation. No mutations on failure. */
export async function inspectProjectRemovalFromHosts(input: {
  targets: readonly ProjectRemoveTarget[];
  deleteNativeSessions?: boolean;
  getClient: (serverId: string) => Pick<DaemonClient, "inspectProjectRemoval"> | null;
}): Promise<InspectedProjectRemoveTarget[]> {
  const clients = input.targets.map((target) => {
    const client = input.getClient(target.serverId);
    if (!client) throw new Error("Host is not connected");
    return { target, client };
  });
  return Promise.all(
    clients.map(async ({ target, client }) => {
      const inspected: InspectedProjectRemoveTarget = {
        serverId: target.serverId,
        projectId: target.projectId,
        deleteSessions: input.deleteNativeSessions
          ? await client.inspectProjectRemoval(target.projectId, true)
          : await client.inspectProjectRemoval(target.projectId),
      };
      if (input.deleteNativeSessions) inspected.deleteNativeSessions = true;
      return inspected;
    }),
  );
}

export function getProjectRemoveReadiness(input: {
  project: ProjectRemoveProject;
  supportsProjectRemove: (serverId: string) => boolean;
  hasHostInfo?: (serverId: string) => boolean;
}): ProjectRemoveReadiness {
  const unavailable = input.project.hosts
    .filter(({ serverId }) => input.hasHostInfo?.(serverId) === false)
    .map(({ serverId }) => serverId);
  if (unavailable.length) return { kind: "host_unavailable", serverIds: unavailable };
  const unsupportedServerIds: string[] = [];
  const targets: ProjectRemoveTarget[] = [];

  for (const host of input.project.hosts) {
    if (!input.supportsProjectRemove(host.serverId)) {
      unsupportedServerIds.push(host.serverId);
      continue;
    }
    targets.push({
      serverId: host.serverId,
      projectId: host.projectId,
    });
  }

  if (unsupportedServerIds.length > 0) {
    return { kind: "needs_host_update", serverIds: unsupportedServerIds };
  }

  return { kind: "ready", targets };
}

export function getCurrentProjectRemoveReadiness(
  project: ProjectRemoveProject,
  getClient?: (serverId: string) => Pick<DaemonClient, "getLastServerInfoMessage"> | null,
): ProjectRemoveReadiness {
  const sessionState = useSessionStore.getState();
  const liveInfo = (serverId: string) => getClient?.(serverId)?.getLastServerInfoMessage();
  return getProjectRemoveReadiness({
    project,
    hasHostInfo: (serverId) =>
      getClient
        ? Boolean(liveInfo(serverId))
        : Boolean(sessionState.sessions[serverId]?.serverInfo),
    supportsProjectRemove: (serverId) =>
      getClient
        ? liveInfo(serverId)?.features?.projectNativeSessionDeletion === true
        : selectHostFeature(sessionState, serverId, "projectNativeSessionDeletion"),
  });
}

export async function removeProjectFromHosts(input: {
  targets: readonly InspectedProjectRemoveTarget[];
  getClient: (serverId: string) => ProjectRemoveClient | null;
}): Promise<ProjectRemoveOutcome> {
  const clients: Array<InspectedProjectRemoveTarget & { client: ProjectRemoveClient }> = [];
  const disconnectedServerIds: string[] = [];

  for (const target of input.targets) {
    const client = input.getClient(target.serverId);
    if (!client) {
      disconnectedServerIds.push(target.serverId);
      continue;
    }
    clients.push({ ...target, client });
  }

  if (disconnectedServerIds.length > 0) {
    return { kind: "host_disconnected", serverIds: disconnectedServerIds };
  }

  const results = await Promise.allSettled(
    clients.map(async ({ client, projectId, deleteSessions, deleteNativeSessions }) => {
      if (deleteNativeSessions)
        await client.removeProject(projectId, undefined, deleteSessions, true);
      else await client.removeProject(projectId, undefined, deleteSessions);
    }),
  );
  const failedServerIds: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const failed = clients[index];
      if (failed) {
        failedServerIds.push(failed.serverId);
      }
    }
  }

  if (failedServerIds.length > 0) {
    return { kind: "failed", serverIds: failedServerIds };
  }

  return { kind: "removed", serverIds: clients.map((entry) => entry.serverId) };
}

/** Never offer a local app update as a remedy for an unrelated remote host. */
export function canOfferProjectHostUpdate(
  unsupportedServerIds: readonly string[],
  localServerId: string | undefined,
  verified: boolean,
): boolean {
  return Boolean(
    verified &&
    localServerId?.trim() &&
    unsupportedServerIds.length &&
    unsupportedServerIds.every((id) => id === localServerId),
  );
}
