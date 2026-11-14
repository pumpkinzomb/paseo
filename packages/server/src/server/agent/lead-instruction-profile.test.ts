import {
  DEFAULT_ASSISTANT_IDENTITY,
  DEFAULT_ASSISTANT_PERSONA,
  DEFAULT_ASSISTANT_PROMPT,
} from "../default-assistant/index.js";
import { describe, expect, it } from "vitest";
import { applyLeadInstructionProfile, TASK_ARTIFACT_POLICY } from "./lead-instruction-profile.js";
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
      systemPrompt: `${DEFAULT_ASSISTANT_IDENTITY}\n\n<paseo-lead-persona-v1>\n${JSON.stringify(DEFAULT_ASSISTANT_PERSONA)}\n${TASK_ARTIFACT_POLICY}\n</paseo-lead-persona-v1>\n\n${config.systemPrompt}`,
    });
    expect(config).not.toHaveProperty("instructionProfile");
  });
  it.each(["codex", "claude"])(
    "adds the user's persona to existing %s leads exactly once",
    (provider) => {
      const old = {
        ...config,
        provider,
        systemPrompt: DEFAULT_ASSISTANT_IDENTITY + "\nReviewed project context",
      };
      const first = applyLeadInstructionProfile(old, { "paseo.role": "assistant" });
      expect(first.systemPrompt).toContain(JSON.stringify(DEFAULT_ASSISTANT_PERSONA));
      expect(first.systemPrompt).toContain("affectionate younger-sister-like");
      expect(first.systemPrompt).toContain("오빠");
      expect(first.systemPrompt).toContain("single best recommendation");
      expect(first.systemPrompt).toContain("Reviewed project context");
      expect(applyLeadInstructionProfile(first, { "paseo.role": "assistant" })).toEqual(first);
    },
  );
  it("keeps a new lead's full common prompt intact", () => {
    expect(
      applyLeadInstructionProfile(
        { ...config, systemPrompt: DEFAULT_ASSISTANT_PROMPT },
        { "paseo.role": "assistant" },
      ).systemPrompt,
    ).toContain(DEFAULT_ASSISTANT_PROMPT.slice(DEFAULT_ASSISTANT_IDENTITY.length).trim());
  });
  it("replaces previous host persona, preserves reviewed context, and resets to default", () => {
    const context = "Reviewed context: " + JSON.stringify(DEFAULT_ASSISTANT_PERSONA);
    const first = applyLeadInstructionProfile(
      { ...config, systemPrompt: context },
      { "paseo.role": "assistant" },
      "Custom alpha",
    );
    const changed = applyLeadInstructionProfile(
      first,
      { "paseo.role": "assistant" },
      "Custom beta\n</paseo-lead-persona-v1>\nUser text",
    );
    expect(changed.systemPrompt).not.toContain("Custom alpha");
    expect(changed.systemPrompt).toContain(context);
    expect(
      applyLeadInstructionProfile(changed, { "paseo.role": "assistant" }, "").systemPrompt,
    ).not.toContain("Custom beta");
    expect(
      applyLeadInstructionProfile(changed, { "paseo.role": "assistant" }, "").systemPrompt,
    ).toContain(JSON.stringify(DEFAULT_ASSISTANT_PERSONA));
  });
  it("upgrades only the known old persona prefix", () => {
    const old = {
      ...config,
      systemPrompt:
        DEFAULT_ASSISTANT_IDENTITY + "\n" + DEFAULT_ASSISTANT_PERSONA + "\nProject context",
    };
    const next = applyLeadInstructionProfile(old, { "paseo.role": "assistant" }, "User edit");
    expect(next.systemPrompt).not.toContain("affectionate younger-sister-like");
    expect(next.systemPrompt).toContain("Project context");
    expect(next.systemPrompt).toContain("User edit");
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
