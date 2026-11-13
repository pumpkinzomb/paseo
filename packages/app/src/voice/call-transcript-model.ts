import type { AssistantMessageItem, StreamItem, UserMessageItem } from "@/types/stream";

type SpokenTurn = AssistantMessageItem | UserMessageItem;
export function collectCallTranscript(
  tail: readonly StreamItem[],
  head: readonly StreamItem[],
  callId?: string,
): SpokenTurn[] {
  const turns = new Map<string, SpokenTurn>();
  for (const row of [...tail, ...head]) {
    if (
      (row.kind !== "user_message" && row.kind !== "assistant_message") ||
      row.source !== "native_voice" ||
      (callId ? row.voiceCallId !== callId : Boolean(row.voiceCallId)) ||
      !row.text.trim()
    )
      continue;
    turns.set(row.messageId ?? row.id, row);
  }
  return [...turns.values()];
}
