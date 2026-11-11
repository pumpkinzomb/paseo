import { DEFAULT_ASSISTANT_IDENTITY } from "../default-assistant/index.js";
import { describe, expect, it } from "vitest";
import { applyLeadInstructionProfile } from "./lead-instruction-profile.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";

describe("lead instruction profile", () => {
  const config: AgentSessionConfig = {
    provider: "claude",
    cwd: "/project",
    systemPrompt: "Sunny identity",
    daemonAppendSystemPrompt: "host policy",
    providerOptions: { model: "example" },
  };
  it("derives the runtime profile from the persisted role, preserving explicit configuration", () => {
    expect(applyLeadInstructionProfile(config, { "paseo.role": "assistant" })).toEqual({
      ...config,
      instructionProfile: "paseo-lead",
      systemPrompt: `${DEFAULT_ASSISTANT_IDENTITY}\n\n${config.systemPrompt}`,
    });
    expect(config).not.toHaveProperty("instructionProfile");
  });
  it("does not leak a lead profile to a native worker", () => {
    expect(
      applyLeadInstructionProfile({
        ...config,
        instructionProfile: "paseo-lead",
      }),
    ).toEqual(config);
  });
});
