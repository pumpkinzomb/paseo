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
