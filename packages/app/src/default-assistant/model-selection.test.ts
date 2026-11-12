import { describe, expect, it } from "vitest";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  assistantModelGroups,
  needsAssistantRuntimeMigration,
  assistantModelChangeKind,
  assistantModelPriceStatus,
  availableAssistantModels,
  buildAssistantModelRoute,
  filterAssistantModelGroups,
} from "./model-selection";
function model(id: string, extra: Partial<AgentModelDefinition> = {}): AgentModelDefinition {
  return { provider: "claude", id, label: id, ...extra };
}
function entry(
  provider: string,
  models: AgentModelDefinition[],
  extra: Partial<ProviderSnapshotEntry> = {},
): ProviderSnapshotEntry {
  return { provider, enabled: true, status: "ready", models, ...extra };
}
const free = { input: 0, output: 0, cache: { read: 0, write: 0 } };
const priced = (cost: unknown, id = "model") =>
  model(id, { provider: "opencode", metadata: { cost } });

describe("assistant full model catalog", () => {
  it("keeps every selectable Codex/Claude model including older versions and non-default families", () => {
    const models = [
      model("opus"),
      model("fable5.2", { isDefault: true }),
      model("fable5.1"),
      model("sonnet"),
      model("haiku"),
      model("hidden", { isSelectable: false }),
      model("opus"),
    ];
    expect(availableAssistantModels(models, "claude").map((m) => m.id)).toEqual([
      "fable5.2",
      "opus",
      "fable5.1",
      "sonnet",
      "haiku",
    ]);
    expect(
      availableAssistantModels(
        [model("Sol"), model("Astra"), model("Terra"), model("older")],
        "codex",
      ),
    ).toHaveLength(4);
  });
  it("excludes only explicit free OpenCode prices, retaining paid and unknown", () => {
    const groups = assistantModelGroups([
      entry("opencode", [
        priced([free], "free"),
        priced([{ ...free, output: 2 }], "paid"),
        model("unknown", { provider: "opencode" }),
      ]),
    ]);
    expect(groups[0]?.models.map((m) => m.id)).toEqual(["paid", "unknown"]);
  });
  it("recognizes positive cache or later tier rates without counting context thresholds", () => {
    expect(
      assistantModelPriceStatus(priced([{ ...free, tier: { type: "context", size: 200000 } }])),
    ).toBe("free");
    expect(
      assistantModelPriceStatus(priced([free, { ...free, cache: { read: 0, write: 1 } }])),
    ).toBe("paid");
    expect(
      assistantModelPriceStatus(priced({ ...free, experimentalOver200K: { ...free, input: 1 } })),
    ).toBe("paid");
  });
  it("preserves unknown prices and ignores misleading names", () => {
    for (const cost of [
      undefined,
      [],
      null,
      { input: 0 },
      { input: 0, output: "0" },
      { ...free, input: -1 },
      { ...free, output: Number.NaN },
    ])
      expect(assistantModelPriceStatus(priced(cost))).toBe("unknown");
    expect(assistantModelPriceStatus(priced([{ ...free, input: 1 }], "actually-free"))).toBe(
      "paid",
    );
    expect(assistantModelPriceStatus(priced(undefined, "free"))).toBe("unknown");
    expect(
      assistantModelPriceStatus(priced({ input: 0, output: 0, cache_read: 0, cache_write: 0 })),
    ).toBe("free");
  });
  it("does not apply OpenCode pricing exclusions to Claude or Codex", () => {
    expect(availableAssistantModels([priced([free])], "claude")).toHaveLength(1);
  });
  it("searches provider names, model labels and ids", () => {
    const groups = assistantModelGroups([
      entry("claude", [model("claude-sonnet"), model("opus")]),
      entry("codex", [model("terra")]),
    ]);
    expect(filterAssistantModelGroups(groups, " SONNET ")[0]?.models.map((m) => m.id)).toEqual([
      "claude-sonnet",
    ]);
    expect(filterAssistantModelGroups(groups, "codex")[0]?.models[0]?.id).toBe("terra");
  });
  it("omits disabled, unavailable, loading and test providers", () => {
    const models = [model("actual")];
    expect(
      assistantModelGroups([
        entry("claude", models),
        entry("disabled", models, { enabled: false }),
        entry("offline", models, { status: "unavailable" }),
        entry("loading", models, { status: "loading" }),
        entry("mock", models),
      ]),
    ).toEqual([{ provider: "claude", label: "claude", models }]);
  });
  it("keeps same-provider changes in place", () => {
    expect(assistantModelChangeKind("codex", "codex")).toBe("in-place");
    expect(assistantModelChangeKind("claude", "claude")).toBe("in-place");
    expect(assistantModelChangeKind("codex", "claude")).toBe("handoff");
  });
  it("encodes a fresh conversation route", () => {
    expect(
      buildAssistantModelRoute(
        "host / one",
        { provider: "open/code", model: "vendor/model?fast=1" },
        "request-1",
      ),
    ).toBe(
      "/h/host%20%2F%20one/assistant?new=request-1&provider=open%2Fcode&model=vendor%2Fmodel%3Ffast%3D1",
    );
  });
});

describe("legacy lead runtime migration", () => {
  const legacy = {
    provider: "codex",
    labels: { "paseo.role": "assistant" },
    runtimeInfo: { extra: { paseoLeadRuntimeStatus: "legacy-unisolated" } },
  };
  it("creates a reviewed successor even when the selected model stays on Codex", () => {
    expect(needsAssistantRuntimeMigration(legacy)).toBe(true);
    expect(assistantModelChangeKind("codex", "codex", true)).toBe("handoff");
    expect(assistantModelChangeKind("codex", "claude", true)).toBe("handoff");
  });
  it("does not migrate workers, unknown profiles, or an already isolated lead", () => {
    expect(needsAssistantRuntimeMigration({ ...legacy, labels: {} })).toBe(false);
    expect(needsAssistantRuntimeMigration({ ...legacy, provider: "claude" })).toBe(false);
    expect(needsAssistantRuntimeMigration({ ...legacy, runtimeInfo: undefined })).toBe(false);
    expect(
      needsAssistantRuntimeMigration({
        ...legacy,
        runtimeInfo: { extra: { paseoLeadRuntimeStatus: "isolated" } },
      }),
    ).toBe(false);
    expect(assistantModelChangeKind("codex", "codex", false)).toBe("in-place");
  });
  it("uses retained metadata before reconnect and gives current runtime precedence", () => {
    const persistence = { metadata: { paseoLeadRuntimeStatus: "legacy-unisolated" } };
    expect(needsAssistantRuntimeMigration({ ...legacy, runtimeInfo: undefined, persistence })).toBe(
      true,
    );
    expect(
      needsAssistantRuntimeMigration({
        ...legacy,
        runtimeInfo: { extra: { paseoLeadRuntimeStatus: "isolated" } },
        persistence,
      }),
    ).toBe(false);
  });
});
