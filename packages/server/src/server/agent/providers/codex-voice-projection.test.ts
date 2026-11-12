import { expect, it } from "vitest";
import { isCodexRealtimeHandoff } from "./codex-voice-projection.js";

it("recognizes only a complete unattributed provider handoff, never authored client input", () => {
  const envelope =
    "<realtime_delegation><input>안녕</input><transcript_delta>user: 안녕 assistant: hello</transcript_delta></realtime_delegation>";
  expect(isCodexRealtimeHandoff(envelope)).toBe(true);
  expect(isCodexRealtimeHandoff(envelope, "user-client-id")).toBe(false);
  for (const text of [
    "<input>hello</input>",
    `<code>${envelope}</code>`,
    `Please review ${envelope}`,
    `\u0060\u0060\u0060xml\n${envelope}\n\u0060\u0060\u0060`,
    "<realtime_delegation>my code</realtime_delegation>",
  ]) {
    expect(isCodexRealtimeHandoff(text)).toBe(false);
  }
});
