import {
  DEFAULT_ASSISTANT_IDENTITY,
  DEFAULT_ASSISTANT_PERSONA,
} from "../default-assistant/index.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";

/** Runtime-only selection: native worker sessions retain their provider configuration. */
export function applyLeadInstructionProfile(
  config: AgentSessionConfig,
  labels?: Record<string, string>,
): AgentSessionConfig {
  const { instructionProfile: _ignored, ...base } = config;
  return labels?.["paseo.role"] === "assistant"
    ? {
        ...base,
        instructionProfile: "paseo-lead",
        systemPrompt: [
          ...(base.systemPrompt?.includes(DEFAULT_ASSISTANT_IDENTITY)
            ? []
            : [DEFAULT_ASSISTANT_IDENTITY]),
          ...(base.systemPrompt?.includes(DEFAULT_ASSISTANT_PERSONA)
            ? []
            : [DEFAULT_ASSISTANT_PERSONA]),
          base.systemPrompt,
        ]
          .filter(Boolean)
          .join("\n\n"),
      }
    : base;
}
