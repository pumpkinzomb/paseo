import { describe, expect, it } from "vitest";
import { canonicalCheckpoint, verifyCheckpoint } from "./checkpoint";

describe("renderer durability checkpoint", () => {
  it("compares exact durable values, independent of object key order", async () => {
    const capture = () => canonicalCheckpoint({ text: "unsent", layout: [1, 2] });
    expect(
      await verifyCheckpoint({
        capture,
        flush: async () => {},
        read: async () => canonicalCheckpoint({ layout: [1, 2], text: "unsent" }),
        revision: () => 1,
      }),
    ).toBe(capture());
  });
  it("rejects write failure without discarding the captured draft", async () => {
    const capture = () => "unsent";
    await expect(
      verifyCheckpoint({
        capture,
        flush: async () => {
          throw new Error("full");
        },
        read: async () => "old",
        revision: () => 0,
      }),
    ).rejects.toThrow("full");
    expect(capture()).toBe("unsent");
  });
  it("rejects new input or cancellation during an in-flight read", async () => {
    let epoch = 0;
    await expect(
      verifyCheckpoint({
        capture: () => "same",
        flush: async () => {},
        read: async () => {
          epoch++;
          return "same";
        },
        revision: () => epoch,
      }),
    ).rejects.toThrow("checkpoint-changed");
  });
  it("rejects a successful write whose readback differs", async () => {
    await expect(
      verifyCheckpoint({
        capture: () => "new",
        flush: async () => {},
        read: async () => "old",
        revision: () => 0,
      }),
    ).rejects.toThrow("checkpoint-not-durable");
  });
  it("times out stalled storage instead of granting admission", async () => {
    await expect(
      verifyCheckpoint({
        capture: () => "draft",
        flush: () => new Promise(() => {}),
        read: async () => "draft",
        revision: () => 0,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("checkpoint-timeout");
  });
});
