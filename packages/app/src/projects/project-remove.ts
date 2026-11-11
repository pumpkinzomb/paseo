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
  | { kind: "needs_host_update"; serverIds: string[] };

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
}
type ProjectRemoveClient = Pick<DaemonClient, "removeProject">;

/** Inspect every host before presenting a destructive confirmation. No mutations on failure. */
export async function inspectProjectRemovalFromHosts(input: {
  targets: readonly ProjectRemoveTarget[];
  getClient: (serverId: string) => Pick<DaemonClient, "inspectProjectRemoval"> | null;
}): Promise<InspectedProjectRemoveTarget[]> {
  const clients = input.targets.map((target) => {
    const client = input.getClient(target.serverId);
    if (!client) throw new Error("Host is not connected");
    return { target, client };
  });
  return Promise.all(
    clients.map(async ({ target, client }) => ({
      serverId: target.serverId,
      projectId: target.projectId,
      deleteSessions: await client.inspectProjectRemoval(target.projectId),
    })),
  );
}

export function getProjectRemoveReadiness(input: {
  project: ProjectRemoveProject;
  supportsProjectRemove: (serverId: string) => boolean;
}): ProjectRemoveReadiness {
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
): ProjectRemoveReadiness {
  const sessionState = useSessionStore.getState();
  return getProjectRemoveReadiness({
    project,
    supportsProjectRemove: (serverId) =>
      selectHostFeature(sessionState, serverId, "projectRemoveSessions"),
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
    clients.map(async ({ client, projectId, deleteSessions }) => {
      await client.removeProject(projectId, undefined, deleteSessions);
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
