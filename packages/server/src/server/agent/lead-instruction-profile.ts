import { DEFAULT_ASSISTANT_IDENTITY } from "../default-assistant/index.js";
import { DEFAULT_ASSISTANT_PERSONA, resolveLeadPersona } from "../default-assistant/persona.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";

const START = "<paseo-lead-persona-v1>\n";
const END = "\n</paseo-lead-persona-v1>";

/** Replace only the host-owned prefix. Reviewed context and project instructions stay intact. */
function withoutLeadPrefix(prompt: string): string {
  let rest = prompt;
  if (rest.startsWith(DEFAULT_ASSISTANT_IDENTITY))
    rest = rest.slice(DEFAULT_ASSISTANT_IDENTITY.length).trimStart();
  if (rest.startsWith(START)) {
    const end = rest.indexOf(END, START.length);
    if (end !== -1) rest = rest.slice(end + END.length).trimStart();
  } else if (rest.startsWith(DEFAULT_ASSISTANT_PERSONA)) {
    // Migrate the known pre-editor persona prefix, never arbitrary text in a handoff.
    rest = rest.slice(DEFAULT_ASSISTANT_PERSONA.length).trimStart();
  }
  return rest;
}

/** Runtime-only selection: native worker sessions retain their provider configuration. */
export function applyLeadInstructionProfile(
  config: AgentSessionConfig,
  labels?: Record<string, string>,
  persona?: string,
): AgentSessionConfig {
  const { instructionProfile: _ignored, ...base } = config;
  if (labels?.["paseo.role"] !== "assistant") return base;
  // JSON encodes newlines, so editable text cannot terminate the owned prefix.
  const block = START + JSON.stringify(resolveLeadPersona(persona)) + END;
  return {
    ...base,
    instructionProfile: "paseo-lead",
    systemPrompt: [DEFAULT_ASSISTANT_IDENTITY, block, withoutLeadPrefix(base.systemPrompt ?? "")]
      .filter(Boolean)
      .join("\n\n"),
  };
}
