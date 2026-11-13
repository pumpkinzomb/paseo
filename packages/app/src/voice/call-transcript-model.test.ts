import { expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { collectCallTranscript } from "./call-transcript-model";

it("keeps actual speakers once across loaded pages/head overlap and survives call end/reopen", () => {
  const rows: StreamItem[] = [
    {
      kind: "user_message",
      id: "u",
      messageId: "u",
      source: "native_voice",
      text: "안녕",
      timestamp: new Date(1),
    },
    {
      kind: "assistant_message",
      id: "a",
      messageId: "a",
      source: "native_voice",
      text: "Hello",
      timestamp: new Date(2),
    },
    {
      kind: "user_message",
      id: "h",
      source: "realtime_handoff",
      text: "<realtime_delegation>internal</realtime_delegation>",
      timestamp: new Date(3),
    },
    { kind: "assistant_message", id: "task", text: "Backend task answer", timestamp: new Date(4) },
  ];
  const record = collectCallTranscript(rows, [rows[1]]);
  expect(record.map(({ kind, text }) => ({ kind, text }))).toEqual([
    { kind: "user_message", text: "안녕" },
    { kind: "assistant_message", text: "Hello" },
  ]);
  expect(collectCallTranscript(rows, [])).toEqual(record);
  expect(collectCallTranscript([], [])).toEqual([]);
});

it("never mixes calls or guesses boundaries for legacy rows", () => {
  const row = (id: string, voiceCallId?: string): StreamItem => ({
    kind: "user_message",
    id,
    messageId: id,
    voiceCallId,
    source: "native_voice",
    text: id,
    timestamp: new Date(1),
  });
  const rows = [row("legacy"), row("first", "one"), row("second", "two")];
  expect(collectCallTranscript(rows, [], "one").map((r) => r.text)).toEqual(["first"]);
  expect(collectCallTranscript(rows, [], "two").map((r) => r.text)).toEqual(["second"]);
  expect(collectCallTranscript(rows, []).map((r) => r.text)).toEqual(["legacy"]);
});
