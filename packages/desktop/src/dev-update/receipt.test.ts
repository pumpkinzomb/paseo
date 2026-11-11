import { expect, it } from "vitest";
import { safeBlockers, safeReceipt } from "./receipt.js";
const valid = { schemaVersion: 1, digest: "a".repeat(64), activityEpoch: 7, capturedAt: 1 };
it("accepts only correctly bound finite integer hash receipts", () => {
  expect(safeReceipt(valid, 7)).toEqual(valid);
  for (const value of [NaN, Infinity, -1, "7", null, Number.MAX_SAFE_INTEGER + 1]) {
    expect(safeReceipt({ ...valid, activityEpoch: value }, 7)).toBeUndefined();
    expect(safeReceipt({ ...valid, capturedAt: value }, 7)).toBeUndefined();
  }
  expect(safeReceipt(valid, 8)).toBeUndefined();
  expect(safeReceipt({ ...valid, schemaVersion: 2 }, 7)).toBeUndefined();
});
it("never forwards arbitrary blocker text or oversized lists", () => {
  expect(safeBlockers(["modified-panel", "private draft text", "modified-panel"])).toEqual([
    "modified-panel",
    "unknown-checkpoint-blocker",
  ]);
  expect(safeBlockers(Array(65).fill("modified-panel"))).toEqual(["unknown-checkpoint-blocker"]);
  expect(safeReceipt({ ...valid, plaintext: "secret" }, 7)).toEqual(valid);
});
it("retains finite internal activity sources without exposing values", () => {
  expect(
    safeBlockers([
      "renderer-browser-changed",
      "renderer-drafts-changed",
      "panel-changed",
      "transient-state-changed",
      "trusted-input",
      "browser-navigation",
      "browser-capture:finished",
      "renderer-browser-changed:private-url",
    ]),
  ).toEqual([
    "renderer-browser-changed",
    "renderer-drafts-changed",
    "panel-changed",
    "transient-state-changed",
    "trusted-input",
    "browser-navigation",
    "browser-capture:finished",
    "unknown-checkpoint-blocker",
  ]);
});
