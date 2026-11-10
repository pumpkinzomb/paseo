import { describe, expect, it, vi } from "vitest";
import { confirmAssistantLifecycle } from "./lifecycle-action";
describe("assistant lifecycle confirmation", () => {
  it.each(["archive", "restore", "delete"] as const)(
    "never mutates %s after cancellation",
    async (action) => {
      const mutate = vi.fn();
      expect(
        await confirmAssistantLifecycle({
          action,
          confirm: async () => false,
          stillActive: () => true,
          mutate,
        }),
      ).toBeNull();
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it("does not delete after navigation during confirmation", async () => {
    const mutate = vi.fn();
    expect(
      await confirmAssistantLifecycle({
        action: "delete",
        confirm: async () => true,
        stillActive: () => false,
        mutate,
      }),
    ).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("sends only the explicitly confirmed action", async () => {
    const mutate = vi.fn(async () => ({ agentIds: ["old", "active"] }));
    expect(
      await confirmAssistantLifecycle({
        action: "delete",
        confirm: async () => true,
        stillActive: () => true,
        mutate,
      }),
    ).toEqual({ agentIds: ["old", "active"] });
    expect(mutate).toHaveBeenCalledExactlyOnceWith("delete");
  });
  it("propagates busy/server failures without retrying a deletion", async () => {
    const mutate = vi.fn(async () => {
      throw new Error("Work is active");
    });
    await expect(
      confirmAssistantLifecycle({
        action: "archive",
        confirm: async () => true,
        stillActive: () => true,
        mutate,
      }),
    ).rejects.toThrow("Work is active");
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
