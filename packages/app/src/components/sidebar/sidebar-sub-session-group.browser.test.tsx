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
}));
vi.mock("@/hooks/use-delete-workspace-sessions", () => ({
  useDeleteWorkspaceSessions: (serverId: string, workspaceId: string) => {
    actions.scopes(serverId, workspaceId);
    return { remove: () => actions.remove(serverId, workspaceId), pending: false };
  },
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: actions.navigate,
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
  actions.remove.mockClear();
  actions.navigate.mockClear();
  actions.scopes.mockClear();
  actions.bulk.mockClear();
  actions.bulkScopes.mockClear();
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(async () => {
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

  it("keeps a parent's cleaned-up sub-sessions under Done when none are live", async () => {
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
      '[data-testid="sidebar-sub-sessions-done-toggle-host:parent"]',
    );
    expect(toggle?.textContent).toBe("Done (1)");

    act(() => toggle?.click());
    expect(
      container.querySelector('[data-testid="sidebar-archived-sub-session-host:agentless"]'),
    ).not.toBeNull();
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
