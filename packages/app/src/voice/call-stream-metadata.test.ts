import { expect, it } from "vitest";
import { applyStreamEvent, hydrateStreamState } from "@/types/stream";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
const user: AgentStreamEventPayload = {
  type: "timeline",
  provider: "codex",
  item: {
    type: "user_message",
    messageId: "u",
    source: "native_voice",
    voiceCallId: "call",
    text: "hi",
  },
};
it("preserves call metadata for history hydration, markers, and live canonical user messages", () => {
  const rows = hydrateStreamState([
    {
      timestamp: new Date(1),
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "notification", level: "info", message: "Voice call", voiceCallId: "call" },
      },
    },
    { timestamp: new Date(2), event: user },
    {
      timestamp: new Date(3),
      event: {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          messageId: "a",
          source: "native_voice",
          voiceCallId: "call",
          text: "hello",
        },
      },
    },
  ]);
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => ("voiceCallId" in row ? row.voiceCallId : undefined))).toEqual([
    "call",
    "call",
    "call",
  ]);
  const live = applyStreamEvent({ tail: [], head: [], event: user, timestamp: new Date(2) });
  expect([...live.tail, ...live.head]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ voiceCallId: "call", source: "native_voice" }),
    ]),
  );
});
