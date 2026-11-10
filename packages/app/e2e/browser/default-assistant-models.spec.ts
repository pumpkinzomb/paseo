import { expect, test } from "../support/fixtures";
import { seedModelProvider } from "../support/helpers/agent-profiles";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test("assistant models show full provider catalogs and cancel without changing the conversation", async ({
  page,
}, testInfo) => {
  const textNodeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Unexpected text node"))
      textNodeErrors.push(message.text());
  });
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "assistant-model-picker-",
    title: "Existing conversation",
  });
  const alpha = await seedModelProvider({
    id: "assistant-alpha",
    label: "Alpha",
    models: [
      { id: "alpha-latest", label: "Alpha 3", description: "Latest Alpha" },
      { id: "alpha-old", label: "Alpha 2", description: "Older Alpha" },
      { id: "beta", label: "Beta 3", description: "Beta" },
      { id: "gamma", label: "Gamma 3", description: "Gamma" },
    ],
  });
  const delta = await seedModelProvider({
    id: "assistant-delta",
    label: "Delta",
    models: [
      { id: "one", label: "One", description: "One" },
      { id: "two", label: "Two", description: "Two" },
    ],
  });
  try {
    await openAgentRoute(page, workspace);
    const originalUrl = page.url();
    await page.locator('[data-testid="default-assistant-models"]:visible').click();
    const picker = page.getByTestId("assistant-model-picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator('[data-testid^="assistant-model-assistant-alpha-"]')).toHaveCount(
      4,
    );
    await expect(picker.getByTestId("assistant-model-assistant-alpha-alpha-old")).toHaveCount(1);
    await picker.getByTestId("assistant-model-search").fill("Alpha 2");
    await expect(picker.locator('[data-testid^="assistant-model-assistant-alpha-"]')).toHaveCount(
      1,
    );
    await expect(picker.getByTestId("assistant-model-assistant-alpha-alpha-old")).toBeVisible();
    await picker.getByTestId("assistant-model-search").fill("");
    await expect(picker.locator('[data-testid^="assistant-model-assistant-delta-"]')).toHaveCount(
      2,
    );
    await expect(picker.locator('[data-testid^="assistant-model-mock-"]')).toHaveCount(0);
    await expect(picker.getByText(/context is not transferred automatically/)).toBeVisible();
    await expect(picker.getByTestId("assistant-model-start")).toBeDisabled();
    await picker.getByTestId("assistant-model-assistant-alpha-alpha-latest").click();
    await expect(picker.getByTestId("assistant-model-start")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("assistant-model-picker.png") });
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(picker).toHaveCount(0);
    await expect(page).toHaveURL(originalUrl);
    await page.locator('[data-testid="default-assistant-models"]:visible').click();
    await expect(picker.getByTestId("assistant-model-start")).toBeDisabled();
    await picker.getByRole("button", { name: "Refresh models", exact: true }).click();
    await expect(picker.locator('[data-testid^="assistant-model-assistant-alpha-"]')).toHaveCount(
      4,
    );
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL(originalUrl);
    await workspace.client.updateAgent(workspace.agentId, {
      labels: { "paseo.role": "assistant" },
    });
    await page.getByTestId("combined-model-selector").click();
    const managerMenu = page.getByTestId("composer-assistant-model-menu");
    await expect(managerMenu).toBeVisible();
    await expect(page.getByTestId("composer-assistant-models")).toHaveCount(0);
    await expect(managerMenu.getByText(/review and edit a context handoff/)).toBeVisible();
    await expect(
      managerMenu.locator('[data-testid^="composer-assistant-model-assistant-alpha-"]'),
    ).toHaveCount(4);
    await expect(
      managerMenu.locator('[data-testid^="composer-assistant-model-assistant-delta-"]'),
    ).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("manager-direct-menu.png") });
    await managerMenu.getByTestId("composer-assistant-model-assistant-alpha-alpha-latest").click();
    const preview = page.getByTestId("assistant-handoff-preview");
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId("assistant-handoff-text")).toBeVisible();
    await expect(preview.getByText(/No model turn runs now/)).toBeVisible();
    await expect(preview.getByTestId("assistant-handoff-confirm")).toBeDisabled();
    await preview
      .getByTestId("assistant-handoff-text")
      .fill("Reviewed handoff draft for testing only.");
    await expect(preview.getByTestId("assistant-handoff-confirm")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("manager-handoff-review.png") });
    await preview.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(page).toHaveURL(originalUrl);
    expect(textNodeErrors).toEqual([]);
  } finally {
    await page.goto("about:blank");
    await delta.restore();
    await alpha.restore();
    await workspace.cleanup();
  }
});
