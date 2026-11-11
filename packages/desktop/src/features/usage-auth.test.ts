import { expect, it, vi } from "vitest";
import { createUsageAuthenticator } from "./usage-auth";
it("starts a real login, coalesces duplicate clicks and permits retry", async () => {
  let finish!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const login = createUsageAuthenticator(run);
  const first = login("cursor");
  expect(login("cursor")).toBe(first);
  expect(run).toHaveBeenCalledOnce();
  finish();
  await first;
  const second = login("cursor");
  expect(run).toHaveBeenCalledTimes(2);
  finish();
  await second;
});
it("never turns untrusted provider IDs into commands", async () => {
  const run = vi.fn();
  await expect(createUsageAuthenticator(run)("cursor; echo bad")).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
it("clears a failed login for retry", async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error("cancelled")).mockResolvedValue(undefined);
  const login = createUsageAuthenticator(run);
  await expect(login("cursor")).rejects.toThrow("cancelled");
  await login("cursor");
  expect(run).toHaveBeenCalledTimes(2);
});
