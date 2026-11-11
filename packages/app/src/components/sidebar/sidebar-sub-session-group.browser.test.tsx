import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { SidebarSubSessionGroup } from "./sidebar-sub-session-group";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
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
    expect(archivedRow?.textContent).toBe("Cleaned-up review보관됨");
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

  it("omits the Done toggle while every sub-session is still working", async () => {
    const container = await mountGroup("en", [entry("running-worker", "needs_input")]);

    expect(container.querySelector('[data-testid="row-running-worker"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-sub-sessions-done-toggle-host:parent"]'),
    ).toBeNull();
  });
});
