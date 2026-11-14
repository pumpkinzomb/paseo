import { describe, expect, it } from "vitest";
import {
  buildAgentDescriptor,
  resolveAgentLabel,
  resolveAssistantTitle,
} from "@/agent-presentation";
import { i18n } from "@/i18n/i18next";
import { buildDraftPanelDescriptor } from "@/panels/draft-panel-descriptor";

function TestIcon() {
  return null;
}

describe("buildDraftPanelDescriptor", () => {
  it("uses the initial prompt title and running loader bucket during create", () => {
    const descriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "Build the dashboard",
      icon: TestIcon,
    });

    expect(descriptor).toMatchObject({
      label: "Build the dashboard",
      subtitle: "Creating agent",
      titleState: "ready",
      statusBucket: "running",
    });
  });

  it("falls back to the draft title for empty create prompts", () => {
    const descriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "   ",
      icon: TestIcon,
    });

    expect(descriptor.label).toBe("New lead agent");
  });

  it("keeps ordinary draft tabs labeled as new agents", () => {
    const descriptor = buildDraftPanelDescriptor({ isCreating: false, icon: TestIcon });

    expect(descriptor).toMatchObject({
      label: "New lead agent",
      subtitle: "New lead agent",
      titleState: "ready",
      statusBucket: null,
    });
  });

  it("uses the active language for draft descriptor chrome", async () => {
    await i18n.changeLanguage("zh-CN");
    const idleDescriptor = buildDraftPanelDescriptor({
      isCreating: false,
      icon: TestIcon,
    });
    const creatingDescriptor = buildDraftPanelDescriptor({
      isCreating: true,
      pendingPrompt: "   ",
      icon: TestIcon,
    });

    expect(idleDescriptor).toMatchObject({
      label: "新建智能体会话",
      subtitle: "新建智能体会话",
    });
    expect(creatingDescriptor).toMatchObject({
      label: "新建智能体会话",
      subtitle: "正在创建 Agent",
    });
    await i18n.changeLanguage("en");
  });
});

describe("shared agent descriptor", () => {
  function describeAgent(overrides: Partial<Parameters<typeof buildAgentDescriptor>[0]> = {}) {
    return buildAgentDescriptor({
      provider: "codex",
      title: "  Review checkout retries  ",
      status: "idle",
      pendingPermissionCount: 0,
      requiresAttention: false,
      attentionReason: null,
      isTurnActive: false,
      icon: TestIcon,
      ...overrides,
    });
  }

  it("keeps the normalized title and provider identity together", () => {
    expect(describeAgent()).toMatchObject({
      label: "Review checkout retries",
      subtitle: "Codex agent",
      icon: TestIcon,
      titleState: "ready",
      statusBucket: "done",
    });
  });

  it.each([null, "", "   ", "New Agent", " new agent "])(
    "leaves an untitled agent loading: %s",
    (title) => {
      expect(resolveAgentLabel(title)).toBeNull();
      expect(describeAgent({ title })).toMatchObject({ label: "", titleState: "loading" });
    },
  );

  it("shows an active turn as running before the lifecycle update arrives", () => {
    expect(describeAgent({ isTurnActive: true }).statusBucket).toBe("running");
  });

  it("shows background work as running without making the turn active", () => {
    expect(describeAgent({ backgroundWork: { count: 1 } })).toMatchObject({
      statusBucket: "running",
      subtitle: "Background work running",
    });
    expect(
      describeAgent({
        backgroundWork: { count: 1 },
        attentionReason: "error",
        requiresAttention: true,
      }).statusBucket,
    ).toBe("failed");
    expect(describeAgent({ backgroundWork: { count: 1 }, status: "error" }).statusBucket).toBe(
      "running",
    );
  });

  it("localizes the background work detail", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(describeAgent({ backgroundWork: { count: 1 } }).subtitle).toBe("后台任务运行中");
    await i18n.changeLanguage("en");
  });

  it("surfaces pending permissions even while the turn is running", () => {
    expect(describeAgent({ isTurnActive: true, pendingPermissionCount: 1 }).statusBucket).toBe(
      "needs_input",
    );
  });

  it.each([
    ["finished", "attention"],
    ["error", "failed"],
    ["permission", "needs_input"],
  ] as const)("preserves %s attention", (attentionReason, statusBucket) => {
    expect(describeAgent({ requiresAttention: true, attentionReason }).statusBucket).toBe(
      statusBucket,
    );
  });
});

describe("lead agent title", () => {
  it.each([null, "Assistant", "Lead agent", " Lead agent "])(
    "shows the localized name for the stored default: %s",
    async (title) => {
      expect(resolveAssistantTitle(title)).toBe("Lead agent");
      await i18n.changeLanguage("ko");
      expect(resolveAssistantTitle(title)).toBe("상위 에이전트");
      await i18n.changeLanguage("en");
    },
  );

  it("keeps a title the user chose", async () => {
    await i18n.changeLanguage("ko");
    expect(resolveAssistantTitle("Release planning")).toBe("Release planning");
    await i18n.changeLanguage("en");
  });
});

it("keeps default lead labels stable and distinct without rewriting stored titles", () => {
  const first = new Date("2026-11-14T01:00:00Z");
  const second = new Date("2026-11-14T01:01:00Z");
  expect(resolveAssistantTitle("Lead agent", first)).not.toBe(
    resolveAssistantTitle("Lead agent", second),
  );
  expect(resolveAssistantTitle("Lead agent", first)).toBe(
    resolveAssistantTitle("Lead agent", new Date(first)),
  );
  expect(resolveAssistantTitle("Release planning", first)).toBe("Release planning");
});

it("distinguishes simultaneous leads using the shared stable anchor suffix", () => {
  const date = new Date("2026-11-14T01:00:00Z");
  expect(resolveAssistantTitle("Lead agent", date, "lead-a")).not.toBe(
    resolveAssistantTitle("Lead agent", date, "lead-b"),
  );
});
