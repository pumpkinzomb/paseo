import { describe, expect, it } from "vitest";
import { createAssistantEntry } from "./entry";

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("default assistant entry", () => {
  it("joins repeated opens and navigates once to the selected conversation", async () => {
    const request = deferred();
    let calls = 0;
    const opened: string[] = [];
    const entry = createAssistantEntry({
      open: () => {
        calls += 1;
        return request.promise;
      },
      navigate: (id) => opened.push(id),
    });
    const first = entry.open();
    const second = entry.open();
    request.resolve("latest-session");
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(opened).toEqual(["latest-session"]);
  });
  it("does not reopen a conversation after leaving the screen", async () => {
    const request = deferred();
    const opened: string[] = [];
    const entry = createAssistantEntry({
      open: () => request.promise,
      navigate: (id) => opened.push(id),
    });
    const opening = entry.open();
    entry.cancel();
    request.resolve("late-session");
    await opening;
    expect(opened).toEqual([]);
  });
  it("propagates a failure and allows an explicit retry", async () => {
    const request = deferred();
    const opened: string[] = [];
    let calls = 0;
    const entry = createAssistantEntry({
      open: () => {
        calls += 1;
        return calls === 1 ? request.promise : Promise.resolve("retry-session");
      },
      navigate: (id) => opened.push(id),
    });
    const opening = entry.open();
    request.reject(new Error("Host offline"));
    await expect(opening).rejects.toThrow("Host offline");
    expect(opened).toEqual([]);
    await entry.open();
    expect(opened).toEqual(["retry-session"]);
  });
});
