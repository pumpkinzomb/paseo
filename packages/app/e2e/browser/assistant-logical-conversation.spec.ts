import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { gotoAppShell } from "../support/helpers/app";

test("one manager tab preserves earlier provider history and routes input to the active segment", async ({
  page,
  e2eWorkerClient,
}) => {
  const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "logical-local-acp" });
  const before = new Set((await e2eWorkerClient.listProjects()).projects.map((p) => p.projectId));
  const command = [
    process.execPath,
    path.resolve(__dirname, "../support/fixtures/logical-conversation-acp.cjs"),
  ];
  try {
    await client.patchDaemonConfig({
      providers: {
        "logical-alpha": { extends: "acp", label: "Local Alpha", enabled: true, command },
        "logical-beta": { extends: "acp", label: "Local Beta", enabled: true, command },
      },
    });
    await client.refreshProvidersSnapshot({ providers: ["logical-alpha", "logical-beta"] });
    const first = await client.ensureDefaultAssistant({
      newSession: true,
      provider: "logical-alpha",
      model: "core-one",
      requestId: "logical-first",
    });
    expect(first.error).toBeNull();
    if (!first.agent || !first.workspace) throw new Error("Missing fixture manager");
    await client.sendMessage(first.agent.id, "Remember that the project color is blue.");
    await expect
      .poll(async () => {
        const timeline = await client.fetchAgentTimeline(first.agent!.id, {
          direction: "tail",
          limit: 30,
        });
        return (
          timeline.agent?.status === "idle" &&
          timeline.entries.some((e) => e.item.type === "assistant_message")
        );
      })
      .toBe(true);
    await gotoAppShell(page);
    await expect(page).toHaveURL(/\/workspace\//);
    const originalUrl = page.url();
    await page.getByTestId("combined-model-selector").click();
    await page.getByTestId("composer-assistant-model-logical-alpha-core-two").click();
    await expect
      .poll(
        async () =>
          (await client.fetchAgentTimeline(first.agent!.id, { direction: "tail", limit: 1 })).agent
            ?.model,
      )
      .toBe("core-two");
    expect(
      (await client.getDefaultAssistantConversation({ agentId: first.agent.id })).conversation
        ?.segments,
    ).toHaveLength(1);
    await expect(page).toHaveURL(originalUrl);
    await page.getByTestId("combined-model-selector").click();
    await page.getByTestId("composer-assistant-model-logical-beta-core-one").click();
    const preview = page.getByTestId("assistant-handoff-preview");
    await expect(preview.getByTestId("assistant-handoff-text")).toHaveValue(
      /project color is blue/,
    );
    await preview.getByTestId("assistant-handoff-confirm").click();
    await expect(preview).toHaveCount(0);
    const conversation = await client.getDefaultAssistantConversation({ agentId: first.agent.id });
    expect(conversation.conversation?.segments).toHaveLength(2);
    const active = conversation.conversation!.activeAgentId;
    expect(active).not.toBe(first.agent.id);
    expect(conversation.conversation!.activeWorkspaceId).toBe(first.workspace.id);
    await expect(page).toHaveURL(originalUrl);
    await expect(page.getByTestId("assistant-conversation-history")).toBeVisible();
    await page.getByTestId("assistant-history-toggle").click();
    await expect(page.getByTestId(`assistant-history-segment-${first.agent.id}`)).toContainText(
      "project color is blue",
    );
    const activeBefore = await client.fetchAgentTimeline(active, { direction: "tail", limit: 20 });
    expect(activeBefore.entries.filter((e) => e.item.type === "assistant_message")).toHaveLength(0);
    await page
      .getByRole("textbox", { name: "Message agent..." })
      .first()
      .fill("Continue with the blue project.");
    await page.getByRole("textbox", { name: "Message agent..." }).first().press("Enter");
    await expect
      .poll(async () =>
        (await client.fetchAgentTimeline(active, { direction: "tail", limit: 20 })).entries.some(
          (e) =>
            e.item.type === "user_message" &&
            e.item.text.includes("Continue with the blue project"),
        ),
      )
      .toBe(true);
    await page.reload();
    await expect(page).toHaveURL(originalUrl);
    await expect(page.getByTestId("assistant-conversation-history")).toBeVisible();
  } finally {
    await page.goto("about:blank");
    for (const project of (await e2eWorkerClient.listProjects()).projects) {
      if (!before.has(project.projectId)) await e2eWorkerClient.removeProject(project.projectId);
    }
    await client.patchDaemonConfig({ removeProviders: ["logical-alpha", "logical-beta"] });
    await client.close();
  }
});
