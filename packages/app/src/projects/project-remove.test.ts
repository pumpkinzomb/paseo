import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { ko } from "@/i18n/resources/ko";
import {
  getProjectRemoveReadiness,
  getCurrentProjectRemoveReadiness,
  canOfferProjectHostUpdate,
  inspectProjectRemovalFromHosts,
  removeProjectFromHosts,
  type ProjectRemoveProject,
} from "./project-remove";

const project: ProjectRemoveProject = {
  hosts: [
    { serverId: "host-a", projectId: "prj_host_a" },
    { serverId: "host-b", projectId: "prj_host_b" },
  ],
};

function createProjectRemoveClient() {
  const removedProjectKeys: string[] = [];
  const scopes: unknown[] = [];
  return {
    removedProjectKeys,
    scopes,
    client: {
      async removeProject(
        projectKey: string,
        _requestId?: string,
        scope?: { workspaceIds: string[]; agentIds: string[] },
      ): Promise<{ removedWorkspaceIds: string[] }> {
        scopes.push(scope);
        removedProjectKeys.push(projectKey);
        return { removedWorkspaceIds: [] };
      },
    },
  };
}

describe("project remove policy", () => {
  it("discloses irreversible Paseo history deletion in the confirmation", () => {
    expect(en.sidebar.project.confirmations.removeMessage).toContain("permanently deleted");
    expect(en.sidebar.project.confirmations.removeMessage).toContain("cannot be restored");
    expect(ko.sidebar.project.confirmations.removeMessage).toContain("영구 삭제");
    expect(ko.sidebar.project.confirmations.removeMessage).toContain("복원할 수 없습니다");
  });

  it("requires every host to support project removal", () => {
    const readiness = getProjectRemoveReadiness({
      project,
      supportsProjectRemove: (serverId) => serverId === "host-a",
    });

    expect(readiness).toEqual({
      kind: "needs_host_update",
      serverIds: ["host-b"],
    });
  });

  it("removes the project from every participating host", async () => {
    const hostA = createProjectRemoveClient();
    const hostB = createProjectRemoveClient();
    const readiness = getProjectRemoveReadiness({
      project,
      supportsProjectRemove: () => true,
    });

    expect(readiness).toEqual({
      kind: "ready",
      targets: [
        { serverId: "host-a", projectId: "prj_host_a" },
        { serverId: "host-b", projectId: "prj_host_b" },
      ],
    });

    const outcome = await removeProjectFromHosts({
      targets:
        readiness.kind === "ready"
          ? readiness.targets.map((target) => ({
              serverId: target.serverId,
              projectId: target.projectId,
              deleteSessions: { workspaceIds: [target.projectId], agentIds: ["parent", "child"] },
            }))
          : [],
      getClient: (serverId) => {
        if (serverId === "host-a") return hostA.client;
        if (serverId === "host-b") return hostB.client;
        return null;
      },
    });

    expect(outcome).toEqual({ kind: "removed", serverIds: ["host-a", "host-b"] });
    expect(hostA.removedProjectKeys).toEqual(["prj_host_a"]);
    expect(hostB.removedProjectKeys).toEqual(["prj_host_b"]);
    expect(hostA.scopes).toEqual([{ workspaceIds: ["prj_host_a"], agentIds: ["parent", "child"] }]);
  });

  it("reports disconnected hosts before sending any remove request", async () => {
    const hostA = createProjectRemoveClient();

    const outcome = await removeProjectFromHosts({
      targets: [
        {
          serverId: "host-a",
          projectId: "prj_host_a",
          deleteSessions: { workspaceIds: [], agentIds: [] },
        },
        {
          serverId: "host-b",
          projectId: "prj_host_b",
          deleteSessions: { workspaceIds: [], agentIds: [] },
        },
      ],
      getClient: (serverId) => (serverId === "host-a" ? hostA.client : null),
    });

    expect(outcome).toEqual({ kind: "host_disconnected", serverIds: ["host-b"] });
    expect(hostA.removedProjectKeys).toEqual([]);
  });
});

describe("project removal inspection", () => {
  it("collects exact host-specific scopes without removing sessions", async () => {
    const calls: string[] = [];
    const targets = await inspectProjectRemovalFromHosts({
      targets: project.hosts,
      getClient: (host) => ({
        async inspectProjectRemoval(projectId) {
          calls.push(projectId);
          return {
            workspaceIds: [host + ":workspace"],
            agentIds: [host + ":parent", host + ":child"],
          };
        },
      }),
    });
    expect(calls).toEqual(["prj_host_a", "prj_host_b"]);
    expect(targets[1]?.deleteSessions).toEqual({
      workspaceIds: ["host-b:workspace"],
      agentIds: ["host-b:parent", "host-b:child"],
    });
  });
  it("fails closed if any host cannot inspect the scope", async () => {
    await expect(
      inspectProjectRemovalFromHosts({
        targets: project.hosts,
        getClient: () => ({
          async inspectProjectRemoval() {
            throw new Error("unsupported host");
          },
        }),
      }),
    ).rejects.toThrow("unsupported host");
  });
  it("checks connectivity before starting inspection", async () => {
    let inspected = false;
    await expect(
      inspectProjectRemovalFromHosts({
        targets: project.hosts,
        getClient: (host) =>
          host === "host-a"
            ? {
                async inspectProjectRemoval() {
                  inspected = true;
                  return { workspaceIds: [], agentIds: [] };
                },
              }
            : null,
      }),
    ).rejects.toThrow("Host is not connected");
    expect(inspected).toBe(false);
  });
});

it("does not call missing host information an outdated host", () => {
  expect(
    getProjectRemoveReadiness({
      project,
      hasHostInfo: (id) => id !== "host-b",
      supportsProjectRemove: () => false,
    }),
  ).toEqual({ kind: "host_unavailable", serverIds: ["host-b"] });
});
it("checks capability independently of a shared app version", () => {
  expect(
    getProjectRemoveReadiness({
      project,
      hasHostInfo: () => true,
      supportsProjectRemove: () => true,
    }),
  ).toEqual({ kind: "ready", targets: project.hosts });
});

it("offers verified local updates only for the exact native host", () => {
  expect(canOfferProjectHostUpdate(["local"], "local", true)).toBe(true);
  expect(canOfferProjectHostUpdate(["remote"], "local", true)).toBe(false);
  expect(canOfferProjectHostUpdate(["local", "remote"], "local", true)).toBe(false);
  expect(canOfferProjectHostUpdate(["local"], undefined, true)).toBe(false);
  expect(canOfferProjectHostUpdate(["local"], "local", false)).toBe(false);
  expect(canOfferProjectHostUpdate([], "local", true)).toBe(false);
});

it("uses the live handshake even before the session replica has host information", () => {
  expect(
    getCurrentProjectRemoveReadiness(project, () => ({
      getLastServerInfoMessage: () => ({ features: { projectRemoveSessions: true } }) as never,
    })),
  ).toEqual({ kind: "ready", targets: project.hosts });
});
it("never substitutes stale replica capabilities for a missing live handshake", () => {
  expect(getCurrentProjectRemoveReadiness(project, () => null)).toEqual({
    kind: "host_unavailable",
    serverIds: ["host-a", "host-b"],
  });
});
