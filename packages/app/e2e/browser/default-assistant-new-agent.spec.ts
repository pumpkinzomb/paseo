import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { createAgentTabFromMenu } from "../support/helpers/workspace-tabs";
import { openGlobalNewWorkspaceComposer } from "../support/helpers/new-workspace";

function workspaceIdFromUrl(page: Page): string | null {
  const match = new URL(page.url()).pathname.match(/\/workspace\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function openAssistantWorkspace(page: Page) {
  await gotoAppShell(page);
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
  const workspaceId = workspaceIdFromUrl(page);
  if (!workspaceId) throw new Error(`No assistant workspace in ${page.url()}`);
  return workspaceId;
}

async function sendFromVisibleComposer(page: Page, text: string) {
  const composer = page
    .getByRole("textbox", { name: "Message agent..." })
    .filter({ visible: true });
  await expect(composer).toBeEditable({ timeout: 30_000 });
  await composer.fill(text);
  await composer.press("Enter");
}

test.describe("new agents in the Assistant project", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a prompt from the Assistant project's + opens the new agent", async ({
    page,
    e2eWorkerClient,
  }) => {
    const before = new Set(
      (await e2eWorkerClient.listProjects()).projects.map((project) => project.projectId),
    );
    try {
      const assistantWorkspaceId = await openAssistantWorkspace(page);
      const assistantWorkspace = (await e2eWorkerClient.fetchWorkspaces()).entries.find(
        (entry) => entry.id === assistantWorkspaceId,
      );
      const project = (await e2eWorkerClient.listProjects()).projects.find(
        (entry) => entry.projectId === assistantWorkspace?.projectId,
      );
      if (!project?.projectKey) throw new Error("Assistant project has no key");
      const viewKey = projectEquivalenceViewKey(project.projectKey);
      const row = page.getByTestId(`sidebar-project-row-${viewKey}`).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.hover();
      await page.getByTestId(`sidebar-project-new-worktree-${viewKey}`).first().click();
      await expect(page).toHaveURL(/\/new(?:\?.*)?$/, { timeout: 30_000 });

      await sendFromVisibleComposer(page, "Hello from the assistant project");

      await expect
        .poll(
          () => {
            const id = workspaceIdFromUrl(page);
            return id && id !== assistantWorkspaceId ? id : null;
          },
          { timeout: 60_000 },
        )
        .not.toBeNull();
      const createdWorkspaceId = workspaceIdFromUrl(page)!;
      const deck = page
        .getByTestId(`workspace-deck-entry-${getServerId()}:${createdWorkspaceId}`)
        .filter({ visible: true });
      await expect(deck.locator('[data-testid^="workspace-tab-agent_"]')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(page.getByText("Hello from the assistant project").first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await page.goto("about:blank");
      for (const project of (await e2eWorkerClient.listProjects()).projects) {
        if (!before.has(project.projectId)) await e2eWorkerClient.removeProject(project.projectId);
      }
    }
  });

  test("a prompt from New workspace with the Assistant project opens the new workspace", async ({
    page,
    e2eWorkerClient,
  }) => {
    const before = new Set(
      (await e2eWorkerClient.listProjects()).projects.map((project) => project.projectId),
    );
    try {
      const assistantWorkspaceId = await openAssistantWorkspace(page);
      await openGlobalNewWorkspaceComposer(page);
      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toContainText(
        "Assistant",
        { timeout: 30_000 },
      );

      await sendFromVisibleComposer(page, "Hello from new workspace");

      await expect
        .poll(
          () => {
            const id = workspaceIdFromUrl(page);
            return id && id !== assistantWorkspaceId ? id : null;
          },
          { timeout: 60_000 },
        )
        .not.toBeNull();
      await expect(page.getByText("Hello from new workspace").first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await page.goto("about:blank");
      for (const project of (await e2eWorkerClient.listProjects()).projects) {
        if (!before.has(project.projectId)) await e2eWorkerClient.removeProject(project.projectId);
      }
    }
  });

  test("a prompt from a new agent tab in the Assistant workspace opens the new agent", async ({
    page,
    e2eWorkerClient,
  }) => {
    const before = new Set(
      (await e2eWorkerClient.listProjects()).projects.map((project) => project.projectId),
    );
    try {
      await openAssistantWorkspace(page);
      await createAgentTabFromMenu(page);
      await sendFromVisibleComposer(page, "Hello from a new assistant tab");
      await expect(page.getByText("Hello from a new assistant tab").first()).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await page.goto("about:blank");
      for (const project of (await e2eWorkerClient.listProjects()).projects) {
        if (!before.has(project.projectId)) await e2eWorkerClient.removeProject(project.projectId);
      }
    }
  });
});
