import { expect, it, vi } from "vitest";
import {
  createLiveUpdateCoordinator,
  type InstalledUpdateCoordinator,
} from "./live-update-coordinator.js";

function candidate(token: string): InstalledUpdateCoordinator {
  return {
    resumeIfPending: vi.fn(async () => {}),
    driver: {
      readStatus: vi.fn(async () => ({
        currentVersion: "1",
        phase: "idle" as const,
        candidate: { version: "2", token },
      })),
      requestUpdate: vi.fn(async () => {}),
    },
  };
}
it("discovers approval published after startup without restart or startup recovery", async () => {
  let key: string | null = null;
  const next = candidate("next");
  const factory = vi.fn(async () => (key ? next : null));
  const live = await createLiveUpdateCoordinator({
    readApprovalKey: async () => key,
    createCoordinator: factory,
    currentVersion: "1",
  });
  await live.resumeIfPending();
  expect((await live.driver.readStatus()).candidate).toBeUndefined();
  key = "approved";
  expect((await live.driver.readStatus()).candidate?.token).toBe("next");
  await live.driver.readStatus();
  expect(factory).toHaveBeenCalledTimes(2);
  expect(next.resumeIfPending).not.toHaveBeenCalled();
  expect(next.driver.requestUpdate).not.toHaveBeenCalled();
});
it("replaces or withdraws idle offers and refuses a stale button click", async () => {
  let key: string | null = "first";
  const first = candidate("first"),
    second = candidate("second");
  const live = await createLiveUpdateCoordinator({
    readApprovalKey: async () => key,
    createCoordinator: async () => {
      if (key === "first") return first;
      return key ? second : null;
    },
    currentVersion: "1",
  });
  key = "second";
  await expect(live.driver.requestUpdate("first")).rejects.toThrow("no longer");
  expect(first.driver.requestUpdate).not.toHaveBeenCalled();
  expect((await live.driver.readStatus()).candidate?.token).toBe("second");
  await live.driver.requestUpdate("second");
  expect(second.driver.requestUpdate).toHaveBeenCalledWith("second");
  key = null;
  expect((await live.driver.readStatus()).candidate).toBeUndefined();
});
it.each(["applying", "failed"] as const)(
  "does not replace a %s coordinator or bypass its fence",
  async (phase) => {
    let key = "first";
    const first = candidate("first");
    vi.mocked(first.driver.readStatus).mockResolvedValue({ currentVersion: "1", phase });
    const factory = vi.fn(async () => first);
    const live = await createLiveUpdateCoordinator({
      readApprovalKey: async () => key,
      createCoordinator: factory,
      currentVersion: "1",
    });
    key = "second";
    expect((await live.driver.readStatus()).phase).toBe(phase);
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(live.driver.requestUpdate("second")).rejects.toThrow();
    expect(first.driver.requestUpdate).not.toHaveBeenCalled();
  },
);
it("invalid discovery hides offers and can recover after corrected publication", async () => {
  let key = "first";
  const first = candidate("first"),
    second = candidate("second");
  const live = await createLiveUpdateCoordinator({
    readApprovalKey: async () => key,
    createCoordinator: async () => {
      if (key === "invalid") throw Error("invalid signature");
      return key === "first" ? first : second;
    },
    currentVersion: "1",
  });
  key = "invalid";
  await expect(live.driver.readStatus()).rejects.toThrow("signature");
  await expect(live.driver.requestUpdate("first")).rejects.toThrow("signature");
  expect(first.driver.requestUpdate).not.toHaveBeenCalled();
  key = "second";
  expect((await live.driver.readStatus()).candidate?.token).toBe("second");
});
it("rejects an approval changed during verification", async () => {
  let key = "first";
  const first = candidate("first");
  const live = await createLiveUpdateCoordinator({
    readApprovalKey: async () => key,
    createCoordinator: async () => {
      if (key === "second") key = "third";
      return first;
    },
    currentVersion: "1",
  });
  key = "second";
  await expect(live.driver.readStatus()).rejects.toThrow("changed during");
});
it("serializes concurrent polling and pins the admitted candidate during application", async () => {
  let key = "first";
  const first = candidate("first");
  let finish!: () => void;
  vi.mocked(first.driver.requestUpdate).mockImplementation(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  const factory = vi.fn(async () => first);
  const live = await createLiveUpdateCoordinator({
    readApprovalKey: async () => key,
    createCoordinator: factory,
    currentVersion: "1",
  });
  const applying = live.driver.requestUpdate("first");
  await vi.waitFor(() => expect(finish).toBeDefined());
  key = "second";
  const polls = [live.driver.readStatus(), live.driver.readStatus()];
  expect(factory).toHaveBeenCalledTimes(1);
  finish();
  await applying;
  await Promise.all(polls);
  expect(factory).toHaveBeenCalledTimes(2);
});
