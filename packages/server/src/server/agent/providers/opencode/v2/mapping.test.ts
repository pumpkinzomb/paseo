import type { AgentInfo, ModelInfo } from "@opencode/client";
import { expect, test } from "vitest";
import { modelsFromV2, modesFromV2 } from "./mapping.js";

test("normalizes v2 model capabilities, variants, and visible primary modes", () => {
  const model: ModelInfo = {
    id: "model",
    modelID: "native-model",
    providerID: "provider",
    name: "Model",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [{ id: "high" }],
    time: { released: 1 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200000, output: 10000 },
  };
  expect(modelsFromV2([model, { ...model, id: "disabled", enabled: false }])).toEqual([
    {
      provider: "opencode",
      id: "provider/model",
      label: "Model",
      contextWindowMaxTokens: 200000,
      metadata: {
        providerId: "provider",
        modelId: "model",
        cost: [],
        supportsAttachments: true,
        supportsToolCall: true,
        contextWindowMaxTokens: 200000,
      },
      thinkingOptions: [{ id: "high", label: "high" }],
    },
  ]);
  const agent: AgentInfo = {
    id: "build",
    name: "Build",
    mode: "primary",
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
  };
  expect(
    modesFromV2([
      agent,
      { ...agent, id: "hidden", hidden: true },
      { ...agent, id: "child", mode: "subagent" },
    ]),
  ).toEqual([{ id: "build", label: "Build", description: undefined }]);
});

test("preserves all v2 pricing tiers without treating context thresholds as prices", () => {
  const cost = [
    { input: 0, output: 0, cache: { read: 0, write: 0 } },
    {
      tier: { type: "context" as const, size: 200000 },
      input: 1,
      output: 2,
      cache: { read: 0.1, write: 0.2 },
    },
  ];
  const model: ModelInfo = {
    id: "paid",
    modelID: "paid",
    providerID: "vendor",
    name: "Paid",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 1 },
    cost,
    status: "active",
    enabled: true,
    limit: { context: 200000, output: 10000 },
  };
  expect(modelsFromV2([model])[0]?.metadata?.cost).toEqual(cost);
});
