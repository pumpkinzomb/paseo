import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

type FetchTimeline = DaemonClient["fetchAgentTimeline"];
type Page = Awaited<ReturnType<FetchTimeline>>;
export interface CallTranscriptTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** Read-only: walk backward to the persisted marker, never infer boundaries from time. */
export async function fetchCallTranscript(
  fetchPage: FetchTimeline,
  agentId: string,
  callId?: string,
): Promise<CallTranscriptTurn[]> {
  let cursor: NonNullable<Parameters<FetchTimeline>[1]>["cursor"];
  const pages: Page[] = [];
  const cursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await fetchPage(agentId, {
      direction: cursor ? "before" : "tail",
      cursor,
      limit: 100,
    });
    if (page.error || page.gap || page.staleCursor) throw new Error("Incomplete call transcript");
    pages.unshift(page);
    const found = page.entries.some(
      ({ item }) => item.type === "notification" && item.voiceCallId === callId,
    );
    if ((callId && found) || !page.hasOlder) {
      return collectTurns(pages, callId);
    }
    if (!page.startCursor) throw new Error("Incomplete call transcript");
    const key = JSON.stringify(page.startCursor);
    if (cursors.has(key)) throw new Error("Repeated call transcript cursor");
    cursors.add(key);
    cursor = page.startCursor;
  }
  throw new Error("Call transcript paging limit reached");
}

function collectTurns(pages: Page[], callId?: string): CallTranscriptTurn[] {
  const turns = new Map<string, CallTranscriptTurn>();
  for (const { entries } of pages)
    for (const { item, seqStart, seqEnd } of entries) {
      if (
        (item.type !== "user_message" && item.type !== "assistant_message") ||
        item.source !== "native_voice" ||
        (callId ? item.voiceCallId !== callId : Boolean(item.voiceCallId)) ||
        !item.text.trim()
      )
        continue;
      const id = item.messageId ?? `${seqStart}:${seqEnd}`;
      turns.set(id, {
        id,
        role: item.type === "user_message" ? "user" : "assistant",
        text: item.text,
      });
    }
  return [...turns.values()];
}
