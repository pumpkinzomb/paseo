import { expect, it } from "vitest";
import { updateNoticeKey } from "./update-notice";
it("groups browser blockers without exposing internal codes", () => {
  expect(
    updateNoticeKey("blocked", [
      "browser-media",
      "browser-uninstrumented-frame",
      "recent-user-activity",
    ]),
  ).toBe("browser");
  expect(updateNoticeKey("blocked", ["recent-user-activity"])).toBe("activity");
  expect(updateNoticeKey("blocked", ["unknown-code"])).toBe("blocked");
});
it("keeps cancellation and saving states distinct", () => {
  expect(updateNoticeKey("canceling", ["cancel-ack-failed"])).toBe("cancelFailed");
  expect(updateNoticeKey("blocked", [], true)).toBe("interrupted");
  expect(updateNoticeKey("committing")).toBe("saving");
  expect(updateNoticeKey("countdown")).toBe("countdown");
});
