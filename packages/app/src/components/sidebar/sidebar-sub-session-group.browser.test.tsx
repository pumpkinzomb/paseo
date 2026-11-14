import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "@vitest/browser/context";
import { render, cleanup, waitFor } from "@testing-library/react";
import { SidebarRoomLeads } from "./sidebar-room-leads";
import { SidebarRoomWorkProvider } from "./sidebar-room-work-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { agent as baseAgent } from "@/plugins/client-state/fixtures";
import type { AssistantConversation } from "@getpaseo/protocol/messages";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { SidebarSubSessionGroup } from "./sidebar-sub-session-group";

const actions = vi.hoisted(() => ({
  remove: vi.fn(),
  navigate: vi.fn(),
  scopes: vi.fn(),
  bulk: vi.fn(),
  bulkScopes: vi.fn(),
  getConversation: vi.fn(),
  listeners: new Set<(event: unknown) => void>(),
}));
const leadClient = {
  getDefaultAssistantConversation: actions.getConversation,
  on: (_type: string, listener: (event: unknown) => void) => {
    actions.listeners.add(listener);
    return () => actions.listeners.delete(listener);
  },
};
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => leadClient,
  useHostRuntimeIsConnected: () => true,
  getHostRuntimeStore: () => ({}),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@/components/provider-icons", () => ({ useProviderIcon: () => () => null }));
vi.mock("@/plugins/workspace-panels/locations", () => ({
  panelTargetSupportsHostForWorkspaceKey: () => true,
}));
vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: (input: { serverId: string; workspaceId: string; agentId: string }) => {
    actions.navigate(input);
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: `${input.serverId}:${input.workspaceId}`,
      target: { kind: "agent", agentId: input.agentId },
      intent: "reveal",
    });
  },
}));
vi.mock("@/hooks/use-delete-workspace-sessions", () => ({
  useDeleteWorkspaceSessions: (
    serverId: string,
    workspaceId: string,
    _onDeleted?: () => void,
    options?: unknown,
  ) => {
    if (options) actions.scopes(serverId, workspaceId, options);
    else actions.scopes(serverId, workspaceId);
    return { remove: () => actions.remove(serverId, workspaceId), pending: false };
  },
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: actions.navigate,
  useActiveWorkspaceSelection: () => ({ serverId: "host", workspaceId: "parent" }),
}));
vi.mock("expo-router", () => ({
  usePathname: () => "/h/host/workspace/parent",
  useRouter: () => ({ push: actions.navigate }),
}));
vi.mock("@/hooks/use-delete-completed-sub-sessions", () => ({
  useDeleteCompletedSubSessions: (serverId: string, parent: string, ids: string[]) => {
    actions.bulkScopes(serverId, parent, ids);
    return { remove: actions.bulk, pending: false };
  },
}));

vi.mock("@/components/sidebar/sidebar-workspace-row-content", () => ({
  sidebarWorkspaceRowStyles: { rowIndented: {} },
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  actions.remove.mockClear();
  actions.navigate.mockClear();
  actions.scopes.mockClear();
  actions.bulk.mockClear();
  actions.bulkScopes.mockClear();
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(async () => {
  cleanup();
  for (const mount of mounted.splice(0)) {
    act(() => mount.root.unmount());
    mount.container.remove();
  }
  await testI18n.changeLanguage("en");
});

function entry(
  workspaceId: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"],
): SidebarWorkspaceEntry {
  return {
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey: "paseo",
    projectName: "paseo",
    workspaceDirectory: `/repo/${workspaceId}`,
    workspaceDirectoryLabel: workspaceId,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    parentWorkspaceId: "parent",
    currentBranch: workspaceId,
    statusBucket,
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

type ArchivedSubSessions = NonNullable<SidebarWorkspaceEntry["archivedSubSessions"]>;

function renderTestRow(row: SidebarWorkspacePlacement) {
  return (
    <div key={row.workspaceKey} data-testid={`row-${row.workspaceId}`}>
      {row.name}
    </div>
  );
}

async function mountGroup(
  language: string,
  entries: SidebarWorkspaceEntry[],
  archivedSubSessions?: ArchivedSubSessions,
) {
  await testI18n.changeLanguage(language);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() =>
    root.render(
      <SidebarSubSessionGroup
        serverId="host"
        parentKey="host:parent"
        parentName="Assistant"
        subSessions={entries.map(placement)}
        archivedSubSessions={archivedSubSessions}
        workspaceEntriesByKey={new Map(entries.map((item) => [item.workspaceKey, item]))}
        renderRow={renderTestRow}
      />,
    ),
  );
  return container;
}

describe("SidebarSubSessionGroup", () => {
  it("shows live sub-sessions and folds finished ones into a collapsed Done toggle", async () => {
    const container = await mountGroup(
      "ko",
      [
        entry("running-worker", "running"),
        entry("finished-worker", "done"),
        entry("second-finished", "done"),
      ],
      [
        {
          workspaceId: "cleaned-up",
          name: "Cleaned-up review",
          archivedAt: "2026-11-11T00:00:00.000Z",
          agentId: "worker-agent",
        },
      ],
    );

    expect(container.querySelector('[data-testid="row-running-worker"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-finished-worker"]')).toBeNull();
    const toggle = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-sub-sessions-done-toggle-host:parent"]',
    );
    expect(toggle?.textContent).toBe("완료 (3)");
    expect(
      container
        .querySelector('[data-testid="sidebar-sub-sessions-host:parent"]')
        ?.getAttribute("aria-label"),
    ).toBe("Assistant의 하위 세션");

    act(() => toggle?.click());

    expect(container.querySelector('[data-testid="row-finished-worker"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="row-second-finished"]')).not.toBeNull();
    const archivedRow = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-archived-sub-session-host:cleaned-up"]',
    );
    expect(archivedRow?.textContent).toBe("Cleaned-up review");
    act(() => toggle?.click());

    expect(container.querySelector('[data-testid="row-finished-worker"]')).toBeNull();
  });

  it("keeps empty preparation history separate from completed sessions", async () => {
    const container = await mountGroup(
      "en",
      [],
      [
        {
          workspaceId: "agentless",
          name: "Agentless",
          archivedAt: "2026-11-11T00:00:00.000Z",
          agentId: null,
        },
      ],
    );
    const toggle = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-workspace-history-toggle-host:parent"]',
    );
    expect(toggle?.textContent).toBe("Workspace history (1)");
    expect(
      container.querySelector('[data-testid="sidebar-sub-sessions-done-toggle-host:parent"]'),
    ).toBeNull();

    act(() => toggle?.click());
    expect(
      container.querySelector('[data-testid="sidebar-archived-sub-session-host:agentless"]'),
    ).not.toBeNull();
    const remove = testElement(container, "sidebar-archived-sub-session-delete-host:agentless");
    expect(remove.getAttribute("aria-label")).toBe("Remove record");
    act(() => remove.click());
    expect(actions.remove).toHaveBeenCalledWith("host", "agentless");
    expect(actions.scopes).toHaveBeenCalledWith("host", "agentless", {
      historyScope: { roomWorkspaceId: "parent", leadAssociation: undefined },
    });
    expect(actions.navigate).not.toHaveBeenCalled();
  });

  it("opens a cleaned-up childs history without navigating to its missing workspace", async () => {
    actions.navigate.mockClear();
    const container = await mountGroup(
      "en",
      [],
      [
        {
          workspaceId: "cleaned",
          name: "Completed child",
          archivedAt: "2026-11-11T00:00:00.000Z",
          agentId: "worker",
        },
      ],
    );
    act(() =>
      container
        .querySelector<HTMLElement>("[data-testid=sidebar-sub-sessions-done-toggle-host\\:parent]")
        ?.click(),
    );
    const row = container.querySelector<HTMLElement>(
      "[data-testid=sidebar-archived-sub-session-host\\:cleaned]",
    );
    act(() => row?.click());
    expect(actions.navigate).toHaveBeenCalledWith({
      pathname: "/h/[serverId]/history/[agentId]",
      params: {
        serverId: "host",
        agentId: "worker",
        workspaceId: "cleaned",
        parentWorkspaceId: "parent",
        name: "Completed child",
      },
    });
    expect(container.querySelector("[data-testid=history-dialog]")).toBeNull();
    // Normal host routing keeps the global sidebar instead of mounting an overlay.
    act(() => row?.click());
    expect(actions.navigate).toHaveBeenCalledTimes(2);
    // Deletion is a separate sibling button, never nested inside the open-history button.
    expect(container.querySelector("button button")).toBeNull();
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it("removes only the selected completed child without opening its history", async () => {
    const container = await mountGroup(
      "en",
      [],
      [
        {
          workspaceId: "child",
          name: "Child",
          archivedAt: "2026-11-11T00:00:00.000Z",
          agentId: "agent",
        },
      ],
    );
    act(() =>
      container
        .querySelector<HTMLElement>('[data-testid="sidebar-sub-sessions-done-toggle-host:parent"]')
        ?.click(),
    );
    act(() =>
      container
        .querySelector<HTMLElement>(
          '[data-testid="sidebar-archived-sub-session-delete-host:child"]',
        )
        ?.click(),
    );
    expect(actions.scopes).toHaveBeenCalledWith("host", "child");
    expect(actions.remove).toHaveBeenCalledTimes(1);
    expect(actions.remove).toHaveBeenCalledWith("host", "child");
    expect(actions.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="history-dialog"]')).toBeNull();
    expect(container.querySelector("button button")).toBeNull();
  });

  it("offers one icon action for completed children only, without expanding or opening a child", async () => {
    const container = await mountGroup(
      "en",
      [entry("running", "needs_input"), entry("finished", "done")],
      [
        {
          workspaceId: "archived",
          name: "Archived",
          archivedAt: "2026-11-11T00:00:00Z",
          agentId: "child",
        },
      ],
    );
    const remove = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-sub-sessions-delete-done-host:parent"]',
    );
    expect(remove?.textContent).toBe("");
    expect(actions.bulkScopes).toHaveBeenCalledWith("host", "parent", ["finished", "archived"]);
    act(() => remove?.click());
    expect(actions.bulk).toHaveBeenCalledTimes(1);
    expect(actions.navigate).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="sidebar-sub-sessions-done-host:parent"]'),
    ).toBeNull();
    expect(container.querySelector("button button")).toBeNull();
  });

  it("omits the Done toggle while every sub-session is still working", async () => {
    const container = await mountGroup("en", [entry("running-worker", "needs_input")]);

    expect(container.querySelector('[data-testid="row-running-worker"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-sub-sessions-done-toggle-host:parent"]'),
    ).toBeNull();
  });
});

function conversation(logicalId: string, ids: string[]): AssistantConversation {
  return {
    logicalId,
    activeAgentId: ids.at(-1)!,
    activeWorkspaceId: "parent",
    segments: ids.map((agentId) => ({
      agentId,
      workspaceId: "parent",
      provider: "codex",
      model: null,
      createdAt: "2026-11-14T00:00:00Z",
    })),
  };
}
const leadA = conversation("logical-a", ["lead-a", "a-continuation"]);
const leadB = conversation("logical-b", ["lead-b"]);
async function mountLeads(
  width = 320,
  runningChild = false,
  secondWork = false,
  assistantRoom = true,
) {
  await testI18n.changeLanguage("en");
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  const store = useSessionStore.getState();
  store.initializeSession("host", null);
  const agents = ["lead-a", "a-continuation", "lead-b"].map((id) =>
    Object.assign({}, baseAgent, {
      id,
      serverId: "host",
      workspaceId: "parent",
      title: id === "lead-b" ? "Second lead" : "First lead",
      labels: { "paseo.role": "assistant" },
      status: "idle" as const,
      requiresAttention: false,
      attentionReason: null,
      pendingPermissions: [],
      turn: { phase: "idle" as const, cancellationRequestId: null },
    }),
  );
  store.setAgents("host", new Map((assistantRoom ? agents : []).map((agent) => [agent.id, agent])));
  if (runningChild)
    store.setAgents(
      "host",
      (previous) =>
        new Map([
          ...previous,
          [
            "shared-child",
            {
              ...baseAgent,
              id: "shared-child",
              serverId: "host",
              workspaceId: "room-source",
              status: "running",
              requiresAttention: false,
              attentionReason: null,
              pendingPermissions: [],
              labels: { "paseo.parent-agent-id": "lead-a", "paseo.parent-server-id": "host" },
            },
          ],
        ]),
    );
  useWorkspaceLayoutStore.setState(useWorkspaceLayoutStore.getInitialState(), true);
  useSidebarCollapsedSectionsStore.setState({ collapsedWorkspaceGroupKeys: new Set() });
  actions.getConversation.mockClear();
  actions.getConversation.mockImplementation(async ({ agentId }: { agentId: string }) => ({
    conversation: agentId === "lead-b" ? leadB : leadA,
    error: null,
  }));
  const records: SidebarWorkspaceEntry[] = [
    entry("owned-1", runningChild ? "running" : "done"),
    entry("owned-2", "done"),
    {
      ...entry("room-source", "done"),
      sessionCount: 0,
      workspacePurpose: "source" as const,
      leadAssociation: {
        serverId: "host",
        roomWorkspaceId: "parent",
        logicalId: "logical-a",
        anchorAgentId: "lead-a",
      },
    },
    {
      ...entry("lab-source", "done"),
      sessionCount: 0,
      workspacePurpose: "source" as const,
      leadAssociation: {
        serverId: "host",
        roomWorkspaceId: "parent",
        logicalId: "logical-a",
        anchorAgentId: "lead-a",
      },
    },
    {
      ...entry("avatar-source", "done"),
      sessionCount: 0,
      workspacePurpose: "planned" as const,
      leadAssociation: {
        serverId: "host",
        roomWorkspaceId: "parent",
        logicalId: "logical-b",
        anchorAgentId: "lead-b",
      },
    },
  ].map((record, index) =>
    index < 2
      ? Object.assign(record, { creatorAgent: { serverId: "host", agentId: "a-continuation" } })
      : record,
  );
  if (secondWork) {
    records.push({ ...entry("unknown-workspace", "done"), sessionCount: undefined });
    records.push({ ...entry("unknown-zero", "done"), sessionCount: 0 });
    records.push({
      ...entry("owned-b", "done"),
      creatorAgent: { serverId: "host", agentId: "lead-b" },
    });
  }
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const archive: NonNullable<SidebarWorkspaceEntry["archivedSubSessions"]> = [
    {
      workspaceId: "empty-preparation",
      name: "Empty preparation",
      archivedAt: "2026-11-14T00:00:00Z",
      agentId: null,
      sessionCount: 0,
      workspacePurpose: "preparation",
      leadAssociation: {
        serverId: "host",
        roomWorkspaceId: "parent",
        logicalId: "logical-a",
        anchorAgentId: "lead-a",
      },
    },
  ];
  archive.push({
    workspaceId: "second-empty-preparation",
    name: "Second empty preparation",
    archivedAt: "2026-11-14T00:00:00Z",
    agentId: null,
    sessionCount: 0,
    workspacePurpose: "preparation",
    leadAssociation: {
      serverId: "host",
      roomWorkspaceId: "parent",
      logicalId: "logical-a",
      anchorAgentId: "lead-a",
    },
  });
  if (secondWork)
    archive.push({
      workspaceId: "unknown-history",
      name: "Unassigned task",
      archivedAt: "2026-11-14T00:00:00Z",
      agentId: "unknown-agent",
      sessionCount: 1,
    });
  if (secondWork)
    archive.push(
      {
        workspaceId: "known-agent-zero",
        name: "Known conversation",
        archivedAt: "2026-11-14T00:00:00Z",
        agentId: "stored-agent",
        sessionCount: 0,
      },
      {
        workspaceId: "unknown-count",
        name: "Unknown inventory",
        archivedAt: "2026-11-14T00:00:00Z",
        agentId: null,
      },
    );
  if (!assistantRoom) {
    for (const record of records) record.leadAssociation = undefined;
    for (const record of archive) record.leadAssociation = undefined;
  }
  const draw = () => (
    <QueryClientProvider client={queryClient}>
      <SidebarRoomWorkProvider
        parentKey="host:parent"
        subSessions={records.map(placement)}
        workspaceEntriesByKey={new Map(records.map((item) => [item.workspaceKey, item]))}
        renderRow={renderTestRow}
      >
        <SidebarRoomLeads
          serverId="host"
          workspaceId="parent"
          parentName="Room"
          archivedSubSessions={archive}
        />
      </SidebarRoomWorkProvider>
    </QueryClientProvider>
  );
  render(draw(), { container });
  await waitFor(() =>
    expect(
      container.querySelector(
        assistantRoom
          ? '[data-testid="sidebar-lead-host:lead-a"]'
          : '[data-testid="row-room-source"]',
      ),
    ).not.toBeNull(),
  );
  return { container, queryClient, records, archive, redraw: () => render(draw(), { container }) };
}
function testElement(container: HTMLElement, id: string) {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}
function patchLead(id: string, fields: Partial<typeof baseAgent>) {
  const next = new Map(useSessionStore.getState().sessions.host!.agents);
  next.set(id, { ...next.get(id)!, ...fields });
  act(() => useSessionStore.getState().setAgents("host", next));
}
function removeActiveSegment() {
  const next = new Map(useSessionStore.getState().sessions.host!.agents);
  next.delete("a-continuation");
  act(() => useSessionStore.getState().setAgents("host", next));
}
describe("logical lead task hierarchy", () => {
  it.each([220, 300, 320])(
    "shows actual Done2 under A and planned B without internal source/history rows at %ipx",
    async (width) => {
      const { container } = await mountLeads(width);
      expect(actions.getConversation).toHaveBeenCalledTimes(2);
      const doneId = "sidebar-sub-sessions-done-toggle-host:parent:lead:logical-a";
      expect(testElement(container, doneId).textContent).toBe("Done (2)");
      expect(
        container.querySelector(
          '[data-testid="sidebar-sub-sessions-done-toggle-host:parent:lead:logical-b"]',
        ),
      ).toBeNull();
      const aGroup = testElement(container, "sidebar-sub-sessions-host:parent:lead:logical-a");
      const bGroup = testElement(container, "sidebar-sub-sessions-host:parent:lead:logical-b");
      expect(testElement(bGroup, "sidebar-room-workspace-avatar-source").textContent).toContain(
        "Not started",
      );
      for (const id of ["room-source", "lab-source"])
        expect(container.querySelector(`[data-testid="sidebar-room-workspace-${id}"]`)).toBeNull();
      expect(
        container.querySelector('[data-testid^="sidebar-workspace-history-toggle-"]'),
      ).toBeNull();
      expect(container.textContent).not.toContain("Room workspaces");
      expect(container.textContent).not.toContain("Workspace history");
      expect(
        aGroup.querySelector('[data-testid="sidebar-room-workspace-avatar-source"]'),
      ).toBeNull();
      expect(container.querySelector('[data-testid^="sidebar-lead-status-"]')).toBeNull();
      expect(actions.scopes).toHaveBeenCalledWith("host", "avatar-source", {
        historyScope: {
          roomWorkspaceId: "parent",
          leadAssociation: {
            serverId: "host",
            roomWorkspaceId: "parent",
            logicalId: "logical-b",
            anchorAgentId: "lead-b",
          },
          itemKind: "planned",
        },
      });
      expect(
        testElement(container, "sidebar-planned-remove-avatar-source").getAttribute("aria-label"),
      ).toBe("Remove record");
      expect(container.querySelector("button button")).toBeNull();
      const before = actions.navigate.mock.calls.length;
      act(() => testElement(bGroup, "sidebar-room-workspace-avatar-source").click());
      expect(actions.navigate.mock.calls.length).toBe(before + 1);
      expect(actions.navigate).toHaveBeenLastCalledWith({
        serverId: "host",
        workspaceId: "avatar-source",
      });
      const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace["host:avatar-source"]!;
      expect(JSON.stringify(layout.root)).toContain('"kind":"files"');
      expect(JSON.stringify(layout.root)).not.toContain('"kind":"agent"');
      if (width === 320) await page.screenshot({ element: container });
      act(() => testElement(container, doneId).click());
      expect(testElement(container, "row-owned-1")).toBeTruthy();
      expect(testElement(container, "row-owned-2")).toBeTruthy();
      expect(actions.bulkScopes).toHaveBeenCalledWith("host", "parent", ["owned-1", "owned-2"]);
      if (width === 320) await page.screenshot({ element: container });
      const beforeNav = actions.navigate.mock.calls.length;
      act(() => testElement(container, "sidebar-lead-toggle-host:lead-a").click());
      expect(actions.navigate.mock.calls.length).toBe(beforeNav);
      expect(container.querySelector('[data-testid="row-owned-1"]')).toBeNull();
      expect(
        testElement(container, "sidebar-lead-toggle-host:lead-a").getAttribute("aria-expanded"),
      ).toBe("false");
      act(() => testElement(container, "sidebar-lead-host:lead-a").click());
      expect(actions.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "lead-a", workspaceId: "parent" }),
      );
      expect(testElement(container, "sidebar-lead-host:lead-a").getAttribute("aria-selected")).toBe(
        "true",
      );
      const persisted = await AsyncStorage.getItem("sidebar-collapsed-sections");
      expect(persisted).not.toBeNull();
      await act(async () => {
        await useSidebarCollapsedSectionsStore.setState({ collapsedWorkspaceGroupKeys: new Set() });
      });
      await AsyncStorage.setItem("sidebar-collapsed-sections", persisted!);
      await act(async () => {
        await useSidebarCollapsedSectionsStore.persist.rehydrate();
      });
      expect(
        testElement(container, "sidebar-lead-toggle-host:lead-a").getAttribute("aria-expanded"),
      ).toBe("false");
      expect(
        testElement(container, "sidebar-lead-toggle-host:lead-b").getAttribute("aria-expanded"),
      ).toBe("true");
      for (const id of ["sidebar-lead-host:lead-a", "sidebar-lead-host:lead-b"]) {
        const bounds = testElement(container, id).getBoundingClientRect();
        expect(bounds.right).toBeLessThanOrEqual(container.getBoundingClientRect().right + 1);
      }
      await page.screenshot({ element: container });
    },
  );
  it("keeps each lead's Done toggle and deletion target list independent", async () => {
    const { container } = await mountLeads(320, false, true);
    expect(
      testElement(container, "sidebar-sub-sessions-done-toggle-host:parent:lead:logical-a")
        .textContent,
    ).toBe("Done (2)");
    expect(
      testElement(container, "sidebar-sub-sessions-done-toggle-host:parent:lead:logical-b")
        .textContent,
    ).toBe("Done (1)");
    act(() =>
      testElement(container, "sidebar-sub-sessions-done-toggle-host:parent:lead:logical-b").click(),
    );
    expect(testElement(container, "row-owned-b")).toBeTruthy();
    expect(container.querySelector('[data-testid="row-owned-1"]')).toBeNull();
    expect(actions.bulkScopes).toHaveBeenCalledWith("host", "parent", ["owned-b"]);
    expect(
      container.querySelector('[data-testid="sidebar-sub-sessions-done-toggle-host:parent"]'),
    ).toBeNull();
    const recovery = testElement(container, "sidebar-room-recovery-host:parent");
    expect(recovery.textContent).toContain("need their lead or purpose");
    expect(testElement(recovery, "sidebar-room-workspace-unknown-workspace")).toBeTruthy();
    expect(testElement(recovery, "sidebar-room-workspace-unknown-zero").textContent).toContain(
      "Review needed",
    );
    expect(testElement(recovery, "sidebar-room-workspace-unknown-zero").textContent).not.toContain(
      "Not started",
    );
    expect(testElement(recovery, "sidebar-archived-sub-session-host:unknown-history")).toBeTruthy();
    expect(
      testElement(recovery, "sidebar-archived-sub-session-host:known-agent-zero"),
    ).toBeTruthy();
    expect(recovery.textContent).not.toContain("Workspace history");
    expect(recovery.textContent).not.toContain("Room workspaces");
    expect(
      container.querySelector(
        '[data-testid="sidebar-archived-sub-session-host:empty-preparation"]',
      ),
    ).toBeNull();
  });
  it("removes only the explicit planned item through its scoped lifecycle boundary", async () => {
    const { container } = await mountLeads();
    act(() => testElement(container, "sidebar-planned-remove-avatar-source").click());
    expect(actions.remove).toHaveBeenCalledExactlyOnceWith("host", "avatar-source");
    expect(actions.navigate).not.toHaveBeenCalled();
    expect(
      testElement(container, "sidebar-sub-sessions-done-toggle-host:parent:lead:logical-a")
        .textContent,
    ).toBe("Done (2)");
  });
  it("keeps ordinary empty project workspaces and preparation history visible", async () => {
    const { container } = await mountLeads(320, false, false, false);
    for (const id of ["room-source", "lab-source", "avatar-source"])
      expect(testElement(container, `row-${id}`)).toBeTruthy();
    expect(testElement(container, "sidebar-workspace-history-toggle-host:parent").textContent).toBe(
      "Workspace history (2)",
    );
    expect(container.querySelector('[data-testid="sidebar-room-leads-host:parent"]')).toBeNull();
  });
  it("keeps actual work under its intended lead when another lead prepared its workspace", async () => {
    const { container, records, redraw } = await mountLeads(320, true);
    const index = records.findIndex((item) => item.workspaceId === "room-source");
    records[index] = {
      ...records[index]!,
      leadAssociation: {
        serverId: "host",
        roomWorkspaceId: "parent",
        logicalId: "logical-b",
        anchorAgentId: "lead-b",
      },
    };
    act(() => {
      redraw();
    });
    const a = testElement(container, "sidebar-sub-sessions-host:parent:lead:logical-a");
    const b = testElement(container, "sidebar-sub-sessions-host:parent:lead:logical-b");
    expect(a.querySelector('[data-testid="sidebar-lead-work-host:shared-child"]')).toBeNull();
    expect(testElement(b, "sidebar-lead-work-host:shared-child")).toBeTruthy();
    expect(testElement(container, "sidebar-lead-work-status-lead-b:running")).toBeTruthy();
    expect(container.querySelector('[data-testid="row-room-source"]')).toBeNull();
  });
  it("shows active provider state separately from delegated work, even when collapsed", async () => {
    const { container } = await mountLeads(300, true);
    expect(container.querySelector('[data-testid="sidebar-lead-status-lead-a:done"]')).toBeNull();
    expect(testElement(container, "sidebar-lead-work-status-lead-a:running")).toBeTruthy();
    expect(testElement(container, "sidebar-lead-work-host:shared-child").textContent).toBe(
      baseAgent.title,
    );
    expect(container.querySelector('[data-testid="row-room-source"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-lead-status-lead-b:done"]')).toBeNull();
    act(() => testElement(container, "sidebar-lead-toggle-host:lead-a").click());
    patchLead("a-continuation", {
      status: "running",
      turn: { phase: "open", turnId: "turn", startedAt: new Date(), cancellationRequestId: null },
    });
    expect(testElement(container, "sidebar-lead-status-lead-a:running")).toBeTruthy();
    expect(container.querySelector('[data-testid="sidebar-lead-status-lead-b:done"]')).toBeNull();
    await page.screenshot({ element: container });
    patchLead("a-continuation", {
      status: "idle",
      turn: { phase: "idle", cancellationRequestId: null },
      requiresAttention: true,
      attentionReason: "finished",
    });
    expect(testElement(container, "sidebar-lead-status-lead-a:attention")).toBeTruthy();
    patchLead("a-continuation", { requiresAttention: true, attentionReason: "permission" });
    expect(testElement(container, "sidebar-lead-status-lead-a:needs_input")).toBeTruthy();
    patchLead("a-continuation", { requiresAttention: true, attentionReason: "error" });
    expect(testElement(container, "sidebar-lead-status-lead-a:failed")).toBeTruthy();
    patchLead("a-continuation", { requiresAttention: true, attentionReason: "finished" });
    patchLead("lead-a", { status: "running" });
    expect(testElement(container, "sidebar-lead-status-lead-a:attention")).toBeTruthy();
    removeActiveSegment();
    await waitFor(() =>
      expect(testElement(container, "sidebar-lead-status-lead-a:loading")).toBeTruthy(),
    );
  });
});
