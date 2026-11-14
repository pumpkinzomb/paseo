import { describe, expect, test } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  isRoomSessionWorkspaceVisible,
  areSubSessionRootKeysEqual,
  groupSubSessionsByActivity,
  partitionRoomWork,
  nestSubSessions,
  resolveSubSessionRootKeys,
} from "./sidebar-sub-sessions";

function entry(
  workspaceId: string,
  input: {
    projectViewKey?: string;
    parentWorkspaceId?: string | null;
    statusBucket?: SidebarWorkspaceEntry["statusBucket"];
    serverId?: string;
  } = {},
): SidebarWorkspaceEntry {
  const serverId = input.serverId ?? "host";
  const projectViewKey = input.projectViewKey ?? "assistant";
  return {
    workspaceKey: `${serverId}:${workspaceId}`,
    serverId,
    workspaceId,
    projectViewKey,
    projectName: projectViewKey,
    workspaceDirectory: `/repo/${workspaceId}`,
    workspaceDirectoryLabel: workspaceId,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    pinnedAt: null,
    labels: [],
    parentWorkspaceId: input.parentWorkspaceId ?? null,
    currentBranch: "main",
    statusBucket: input.statusBucket ?? "running",
    sessionCount: 1,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

function placement(source: SidebarWorkspaceEntry): SidebarWorkspacePlacement {
  return {
    workspaceKey: source.workspaceKey,
    serverId: source.serverId,
    workspaceId: source.workspaceId,
    projectViewKey: source.projectViewKey,
    projectName: source.projectName,
    projectKind: source.projectKind,
    workspaceKind: source.workspaceKind,
    name: source.name,
  };
}

function project(viewKey: string, workspaces: SidebarWorkspaceEntry[]): SidebarProjectEntry {
  return {
    viewKey,
    projectName: viewKey,
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [],
    workspaces: workspaces.map(placement),
  };
}

describe("resolveSubSessionRootKeys", () => {
  test("nests a sub-session in another project under the session that created it", () => {
    const parent = entry("assistant-session");
    const child = entry("paseo-worktree", {
      projectViewKey: "paseo",
      parentWorkspaceId: "assistant-session",
    });

    expect(resolveSubSessionRootKeys({ entries: [parent, child] })).toEqual(
      new Map([["host:paseo-worktree", "host:assistant-session"]]),
    );
  });

  test("joins a sub-session of a sub-session to the same root session", () => {
    const entries = [
      entry("root"),
      entry("child", { parentWorkspaceId: "root" }),
      entry("grandchild", { parentWorkspaceId: "child" }),
    ];

    expect(resolveSubSessionRootKeys({ entries })).toEqual(
      new Map([
        ["host:child", "host:root"],
        ["host:grandchild", "host:root"],
      ]),
    );
  });

  test("leaves a sub-session in place when its parent is not visible", () => {
    const orphan = entry("child", { parentWorkspaceId: "archived-parent" });

    expect(resolveSubSessionRootKeys({ entries: [orphan] }).size).toBe(0);
  });

  test("never nests across hosts", () => {
    const entries = [
      entry("parent", { serverId: "laptop" }),
      entry("child", { serverId: "desktop", parentWorkspaceId: "parent" }),
    ];

    expect(resolveSubSessionRootKeys({ entries }).size).toBe(0);
  });

  test("keeps pinned sessions out of nesting on either side", () => {
    const entries = [
      entry("parent"),
      entry("pinned-child", { parentWorkspaceId: "parent" }),
      entry("pinned-parent"),
      entry("child-of-pinned", { parentWorkspaceId: "pinned-parent" }),
    ];

    expect(
      resolveSubSessionRootKeys({
        entries,
        pinnedWorkspaceKeys: new Set(["host:pinned-child", "host:pinned-parent"]),
      }).size,
    ).toBe(0);
  });

  test("nests nothing along a parent cycle", () => {
    const entries = [
      entry("a", { parentWorkspaceId: "b" }),
      entry("b", { parentWorkspaceId: "a" }),
    ];

    expect(resolveSubSessionRootKeys({ entries }).size).toBe(0);
  });
});

describe("areSubSessionRootKeysEqual", () => {
  test("compares by content so status churn keeps one nesting identity", () => {
    expect(
      areSubSessionRootKeysEqual(new Map([["host:a", "host:b"]]), new Map([["host:a", "host:b"]])),
    ).toBe(true);
    expect(
      areSubSessionRootKeysEqual(new Map([["host:a", "host:b"]]), new Map([["host:a", "host:c"]])),
    ).toBe(false);
  });
});

describe("nestSubSessions", () => {
  const parent = entry("assistant-session");
  const sibling = entry("other-session");
  const child = entry("paseo-worktree", {
    projectViewKey: "paseo",
    parentWorkspaceId: "assistant-session",
  });
  const projects = [project("assistant", [parent, sibling]), project("paseo", [child])];

  test("moves sub-sessions under their parent and drops the project they emptied", () => {
    const nesting = nestSubSessions({
      projects,
      rootKeyByChildKey: resolveSubSessionRootKeys({ entries: [parent, sibling, child] }),
    });

    expect(nesting.projects.map((item) => item.viewKey)).toEqual(["assistant"]);
    expect(nesting.projects[0]).toBe(projects[0]);
    expect(
      nesting.childrenByParentKey.get("host:assistant-session")?.map((c) => c.workspaceKey),
    ).toEqual(["host:paseo-worktree"]);
  });

  test("keeps a project that still has its own sessions", () => {
    const mainCheckout = entry("paseo-main", { projectViewKey: "paseo" });
    const nesting = nestSubSessions({
      projects: [project("assistant", [parent]), project("paseo", [mainCheckout, child])],
      rootKeyByChildKey: resolveSubSessionRootKeys({ entries: [parent, mainCheckout, child] }),
    });

    expect(nesting.projects.map((item) => item.viewKey)).toEqual(["assistant", "paseo"]);
    expect(nesting.projects[1]?.workspaces.map((w) => w.workspaceKey)).toEqual(["host:paseo-main"]);
  });

  test("keeps an empty project header so its first session can be started", () => {
    const empty = project("fresh", []);
    const nesting = nestSubSessions({
      projects: [...projects, empty],
      rootKeyByChildKey: resolveSubSessionRootKeys({ entries: [parent, sibling, child] }),
    });

    expect(nesting.projects.map((item) => item.viewKey)).toEqual(["assistant", "fresh"]);
  });

  test("returns the input projects untouched when nothing nests", () => {
    const nesting = nestSubSessions({ projects, rootKeyByChildKey: new Map() });

    expect(nesting.projects).toBe(projects);
    expect(nesting.childrenByParentKey.size).toBe(0);
  });
});

describe("groupSubSessionsByActivity", () => {
  test("collapses finished sub-sessions into done and keeps live ones visible", () => {
    const running = entry("running", { statusBucket: "running" });
    const waiting = entry("waiting", { statusBucket: "needs_input" });
    const finished = entry("finished", { statusBucket: "done" });
    const entries = new Map([running, waiting, finished].map((e) => [e.workspaceKey, e]));

    const groups = groupSubSessionsByActivity({
      children: [running, waiting, finished].map(placement),
      workspaceEntriesByKey: entries,
    });

    expect(groups.active.map((c) => c.workspaceId)).toEqual(["running", "waiting"]);
    expect(groups.done.map((c) => c.workspaceId)).toEqual(["finished"]);
  });
});

describe("room logical-lead ownership", () => {
  const leads = [
    { logicalId: "A", segments: [{ agentId: "anchor" }, { agentId: "continuation" }] },
    { logicalId: "B", segments: [{ agentId: "other" }] },
  ];
  test("partitions by any exact provider segment without sibling/host bleed", () => {
    const a = { id: "a", creatorAgent: { serverId: "host", agentId: "continuation" } };
    const b = { id: "b", creatorAgent: { serverId: "host", agentId: "other" } };
    const foreign = { id: "remote", creatorAgent: { serverId: "foreign", agentId: "anchor" } };
    const unknown = { id: "legacy", creatorAgent: undefined };
    const result = partitionRoomWork("host", leads, [a, b, foreign, unknown]);
    expect(result.byLead.get("A")).toEqual([a]);
    expect(result.byLead.get("B")).toEqual([b]);
    expect(result.unassigned).toEqual([foreign, unknown]);
    expect(partitionRoomWork("host", [], [a]).unassigned).toEqual([a]);
  });
  test("complete zero-session and unknown inventories stay workspace navigation", () => {
    const source = { ...entry("source", { statusBucket: "done" }), sessionCount: 0 };
    const unknown = { ...entry("unknown", { statusBucket: "done" }), sessionCount: undefined };
    const task = entry("task", { statusBucket: "done" });
    const groups = groupSubSessionsByActivity({
      children: [source, unknown, task].map(placement),
      workspaceEntriesByKey: new Map(
        [source, unknown, task].map((item) => [item.workspaceKey, item]),
      ),
    });
    expect(groups.active.map((item) => item.workspaceId)).toEqual(["source", "unknown"]);
    expect(groups.done.map((item) => item.workspaceId)).toEqual(["task"]);
  });
});

describe("assistant-room conversation visibility", () => {
  test("hides only confirmed zero-session entries inside a resolved lead room", () => {
    const source = Object.freeze({ ...entry("source"), sessionCount: 0 });
    const before = structuredClone(source);
    expect(
      isRoomSessionWorkspaceVisible({
        hasLeads: true,
        sessionCount: source.sessionCount,
        hasAgentEvidence: false,
      }),
    ).toBe(false);
    expect(
      isRoomSessionWorkspaceVisible({ hasLeads: false, sessionCount: 0, hasAgentEvidence: false }),
    ).toBe(true);
    expect(
      isRoomSessionWorkspaceVisible({
        hasLeads: true,
        sessionCount: undefined,
        hasAgentEvidence: false,
      }),
    ).toBe(true);
    expect(
      isRoomSessionWorkspaceVisible({ hasLeads: true, sessionCount: 1, hasAgentEvidence: false }),
    ).toBe(true);
    expect(
      isRoomSessionWorkspaceVisible({ hasLeads: true, sessionCount: 0, hasAgentEvidence: true }),
    ).toBe(true);
    expect(source).toEqual(before);
  });
});
