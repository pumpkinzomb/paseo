/** Only a local, editable draft. This is never authorization to send it. */
export const ASSISTANT_HANDOFF_MAX_CHARS = 12_000;

export interface HandoffDraftEntry {
  item: { type: string; text?: string };
}

export interface AssistantHandoffDraft {
  text: string;
  includedMessages: number;
  omittedMessages: number;
  sensitiveMessages: number;
  truncated: boolean;
}

// Defense in depth, not a complete secret classifier. The UI must require review.
const SENSITIVE_TEXT = [
  /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----/iu,
  /\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|xox[baprs]-)[a-z\d_-]{12,}/iu,
  /\bBearer\s+[a-z\d._~+/-]{12,}/iu,
  /\b(?:password|passwd|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|recovery[_ -]?(?:code|seed)|private[_ -]?key)\s*[=:]\s*\S+/iu,
  /[?&](?:token|key|secret|signature|sig|code)=[^\s&]{8,}/iu,
  /\b\d{3}-\d{2}-\d{4}\b/u,
  /\b(?:\d[ -]?){13,19}\b/u,
];

/** Keep only recent human/assistant prose; never reasonings, tools or internal messages. */
export function buildAssistantHandoffDraft(
  entries: readonly HandoffDraftEntry[],
  maxChars = ASSISTANT_HANDOFF_MAX_CHARS,
): AssistantHandoffDraft {
  const limit = Math.max(0, Math.min(ASSISTANT_HANDOFF_MAX_CHARS, Math.floor(maxChars)));
  const messages: string[] = [];
  let omittedMessages = 0;
  let sensitiveMessages = 0;
  for (const { item } of entries) {
    if (!["user_message", "assistant_message"].includes(item.type) || !item.text?.trim()) {
      omittedMessages++;
      continue;
    }
    if (/<\/?(?:paseo-system|system|developer|tool_result|tool_call)\b/iu.test(item.text)) {
      omittedMessages++;
      continue;
    }
    if (SENSITIVE_TEXT.some((pattern) => pattern.test(item.text!))) {
      sensitiveMessages++;
      omittedMessages++;
      continue;
    }
    messages.push(`${item.type === "user_message" ? "User" : "Assistant"}:\n${item.text.trim()}`);
  }
  const selected: string[] = [];
  let length = 0;
  let truncated = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const remaining = limit - length - (selected.length ? 2 : 0);
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (message.length > remaining) {
      // Preserve the latest message tail without pretending it is complete.
      const marker = "[Earlier text omitted]\n";
      if (remaining > marker.length) {
        selected.unshift(marker + message.slice(-(remaining - marker.length)));
      }
      truncated = true;
      break;
    }
    selected.unshift(message);
    length += message.length + (selected.length > 1 ? 2 : 0);
  }
  return {
    text: selected.join("\n\n"),
    includedMessages: selected.length,
    omittedMessages: omittedMessages + messages.length - selected.length,
    sensitiveMessages,
    truncated,
  };
}

/** Carry only the last reviewed handoff, not omitted raw history or provider instructions.
 * The combined draft is still editable and must be approved for the new destination.
 */
export function buildContinuedAssistantHandoffDraft(
  entries: readonly HandoffDraftEntry[],
  reviewedContext?: string,
): AssistantHandoffDraft {
  const recent = buildAssistantHandoffDraft(entries);
  if (!reviewedContext?.trim()) return recent;
  const context = reviewedContext.trim();
  const separator = recent.text ? "\n\n[Current conversation]\n" : "";
  // Do not silently truncate a previously approved reference. Keep it in full and
  // budget the recent messages around it; all omissions stay visible in the preview.
  const remaining = Math.max(0, ASSISTANT_HANDOFF_MAX_CHARS - context.length - separator.length);
  const boundedRecent = buildAssistantHandoffDraft(entries, remaining);
  return {
    ...boundedRecent,
    text: context + (boundedRecent.text ? separator + boundedRecent.text : ""),
    truncated: boundedRecent.truncated || recent.truncated,
  };
}
