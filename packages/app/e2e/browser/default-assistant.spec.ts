import { randomUUID } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { seedWorkspace } from "../support/helpers/seed-client";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import { expect, test } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { gotoAppShell } from "../support/helpers/app";

test("opens the assistant without project selection and restores the new conversation", async ({
  page,
  e2eWorkerClient,
}) => {
  const before = new Set(
    (await e2eWorkerClient.listProjects()).projects.map((project) => project.projectId),
  );
  try {
    await gotoAppShell(page);
    const toolbar = page.locator('[data-testid="default-assistant-toolbar"]:visible');
    await expect(toolbar).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
    const first = page.url();
    await page.locator('[data-testid="default-assistant-new"]:visible').click();
    await expect(toolbar).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.url()).not.toBe(first);
    await expect(page).toHaveURL(/\/workspace\//);
    const latest = page.url();
    await gotoAppShell(page);
    await expect(page).toHaveURL(latest);
    await expect(toolbar).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(latest);
    await expect(toolbar).toBeVisible();
  } finally {
    await page.goto("about:blank");
    const projects = (await e2eWorkerClient.listProjects()).projects;
    for (const project of projects) {
      if (!before.has(project.projectId)) await e2eWorkerClient.removeProject(project.projectId);
    }
  }
});

test("keeps a failed assistant open actionable without silently replacing its session", async ({
  page,
  e2eWorkerClient,
}) => {
  const before = new Set(
    (await e2eWorkerClient.listProjects()).projects.map((project) => project.projectId),
  );
  try {
    const entryUrl = `/h/${getServerId()}/assistant?new=archived-request-test`;
    await page.goto(entryUrl);
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    const workspaceId = new URL(page.url()).pathname.split("/").at(-1);
    if (!workspaceId) throw new Error("Missing assistant workspace");
    await e2eWorkerClient.archiveWorkspace(workspaceId);
    await page.goto(entryUrl);
    await expect(page.getByTestId("default-assistant-error")).toContainText("archived or removed");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("default-assistant-error")).toContainText("archived or removed");
    await page.getByRole("button", { name: "Open projects", exact: true }).click();
    await expect(page).toHaveURL(/\/open-project$/);
  } finally {
    await page.goto("about:blank");
    for (const project of (await e2eWorkerClient.listProjects()).projects) {
      if (!before.has(project.projectId)) await e2eWorkerClient.removeProject(project.projectId);
    }
  }
});

test("room lead sidebar shares tab identity, selection, rename and layout-only close across reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspace = await seedWorkspace({ repoPrefix: "room-leads-" });
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "room-leads" });
  try {
    const first = await client.ensureDefaultAssistant({
      newSession: true,
      workspaceId: workspace.workspaceId,
      requestId: randomUUID(),
    });
    const second = await client.ensureDefaultAssistant({
      newSession: true,
      workspaceId: workspace.workspaceId,
      requestId: randomUUID(),
    });
    if (!first.agent || !second.agent)
      throw new Error(first.error || second.error || "Missing leads");
    const serverId = getServerId();
    await page.goto(buildHostAgentDetailRoute(serverId, first.agent.id, workspace.workspaceId));
    await expect(
      page.getByTestId(`sidebar-lead-${serverId}:${first.agent.id}`).first(),
    ).toBeVisible({ timeout: 30_000 });
    const firstRow = page.getByTestId(`sidebar-lead-${serverId}:${first.agent.id}`).first();
    const secondRow = page.getByTestId(`sidebar-lead-${serverId}:${second.agent.id}`).first();
    const tab = (id: string) => page.getByTestId(`workspace-tab-agent_${id}`).first();
    await expect(secondRow).toBeVisible();
    expect(await firstRow.innerText()).not.toBe(await secondRow.innerText());
    await secondRow.click();
    await expect(tab(second.agent.id)).toBeVisible();
    await expect(secondRow).toHaveAttribute("aria-selected", "true");
    await firstRow.click();
    await expect(firstRow).toHaveAttribute("aria-selected", "true");
    await tab(second.agent.id).click({ button: "right" });
    await page.getByTestId(`workspace-tab-context-agent_${second.agent.id}-close`).click();
    await expect(tab(second.agent.id)).toHaveCount(0);
    await expect(secondRow).toBeVisible();
    await page.reload();
    await expect(secondRow).toBeVisible({ timeout: 30_000 });
    await secondRow.click();
    await expect(tab(second.agent.id)).toBeVisible();
    await tab(second.agent.id).click({ button: "right" });
    await page.getByTestId(`workspace-tab-context-agent_${second.agent.id}-rename`).click();
    const modal = `workspace-tab-rename-modal-agent-${second.agent.id}`;
    await renameModalInput(page, modal).fill("Release planning");
    await renameModalSubmit(page, modal).click();
    await expect(secondRow).toContainText("Release planning");
    await expect(tab(second.agent.id)).toContainText("Release planning");
    await expect(page.getByTestId("workspace-session-toolbar")).toHaveCount(0);
    await page.getByTestId("workspace-new-tab-button").first().click();
    await expect(page.getByTestId("workspace-new-tab-menu-agent")).toContainText("New lead agent");
    await page.getByTestId("workspace-new-tab-menu-agent").click();
    // A draft has no persisted lead identity until its first submission.
    await expect(
      page
        .getByTestId(`sidebar-room-leads-${serverId}:${workspace.workspaceId}`)
        .first()
        .locator('[data-testid^="sidebar-lead-"]'),
    ).toHaveCount(2);
    const source = await client.fetchAgent({ agentId: second.agent.id });
    if (!source) throw new Error("Missing handoff source");
    const continuation = await client.ensureDefaultAssistant({
      newSession: true,
      requestId: randomUUID(),
      provider: second.agent.provider,
      handoff: {
        sourceAgentId: second.agent.id,
        sourceUpdatedAt: source.agent.updatedAt,
        text: "Reviewed navigation test context",
      },
    });
    if (continuation.error || !continuation.agent)
      throw new Error(continuation.error || "Missing continuation");
    await expect(page.getByTestId(`sidebar-lead-${serverId}:${continuation.agent.id}`)).toHaveCount(
      0,
    );
    await expect(secondRow).toContainText("Release planning");
    await expect(
      page
        .getByTestId(`sidebar-room-leads-${serverId}:${workspace.workspaceId}`)
        .first()
        .locator('[data-testid^="sidebar-lead-"]'),
    ).toHaveCount(2);
    await secondRow.click();
    await expect(tab(second.agent.id)).toContainText("Release planning");
    await page.screenshot({ path: test.info().outputPath("room-leads-wide.png") });
    await page.setViewportSize({ width: 820, height: 800 });
    await page.screenshot({ path: test.info().outputPath("room-leads-820.png") });
    await client.mutateAssistantConversation(first.agent.id, "archive");
    await expect(firstRow).toHaveCount(0);
    await expect(secondRow).toBeVisible();
  } finally {
    await page.goto("about:blank");
    await client.close();
    await workspace.cleanup();
  }
});
