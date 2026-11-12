import { expect, it, vi } from "vitest";
import { fetchCallTranscript } from "./fetch-call-transcript";
type Fetch = Parameters<typeof fetchCallTranscript>[0];
function speech(text: string, voiceCallId = "one", source = "native_voice") {
  return {
    seqStart: 1,
    seqEnd: 1,
    item: { type: "user_message", messageId: text, text, source, voiceCallId },
  };
}
function fetcher(...pages: unknown[]): Fetch {
  const mock = vi.fn();
  for (const page of pages) mock.mockResolvedValueOnce(page);
  return mock as Fetch;
}
it("loads back to selected call marker, preserves order, excludes other calls and task text", async () => {
  const fetch = fetcher(
    {
      entries: [speech("new"), speech("other", "two"), speech("task", "one", "text")],
      hasOlder: true,
      startCursor: { epoch: "e", seq: 10 },
    },
    {
      entries: [
        {
          seqStart: 1,
          seqEnd: 1,
          item: { type: "notification", voiceCallId: "one", message: "call", level: "info" },
        },
        speech("old"),
      ],
      hasOlder: true,
      startCursor: { epoch: "e", seq: 1 },
    },
  );
  expect((await fetchCallTranscript(fetch, "agent", "one")).map((r) => r.text)).toEqual([
    "old",
    "new",
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("deduplicates overlapping pages by message identity", async () => {
  const fetch = fetcher(
    { entries: [speech("same")], hasOlder: true, startCursor: { epoch: "e", seq: 2 } },
    { entries: [speech("same")], hasOlder: false },
  );
  expect(await fetchCallTranscript(fetch, "agent", "one")).toHaveLength(1);
});
it("rejects incomplete pages instead of showing a falsely complete record", async () => {
  await expect(
    fetchCallTranscript(fetcher({ entries: [], gap: true }), "agent", "one"),
  ).rejects.toThrow();
  await expect(
    fetchCallTranscript(fetcher({ entries: [], staleCursor: true }), "agent", "one"),
  ).rejects.toThrow();
  await expect(
    fetchCallTranscript(fetcher({ entries: [], hasOlder: true }), "agent", "one"),
  ).rejects.toThrow();
});
it("stops repeated cursors rather than looping", async () => {
  const page = { entries: [], hasOlder: true, startCursor: { epoch: "e", seq: 2 } };
  await expect(fetchCallTranscript(fetcher(page, page), "agent", "one")).rejects.toThrow(
    "Repeated",
  );
});

it("loads all legacy voice pages without inventing calls or including worker reports", async () => {
  const old = (text: string) => ({ ...speech(text), item: { ...speech(text).item, voiceCallId: undefined } });
  const fetch = fetcher(
    { entries: [old("later"), speech("new call"), speech("SOURCE INTEGRATION COMPLETE", "", "text")], hasOlder: true, startCursor: { epoch: "e", seq: 5 } },
    { entries: [{ seqStart: 1, seqEnd: 1, item: { type: "notification", message: "ordinary notice" } }, old("earlier")], hasOlder: false },
  );
  expect((await fetchCallTranscript(fetch, "agent")).map((r) => r.text)).toEqual(["earlier", "later"]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
