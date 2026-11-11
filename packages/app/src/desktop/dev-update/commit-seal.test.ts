import { afterEach, expect, it, vi } from "vitest";
import { createRendererCommitSeal } from "./commit-seal";
afterEach(() => vi.useRealTimers());
function attempt(trusted = true) {
  return { isTrusted: trusted, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
}
it("does not fence editable prepare/countdown and preserves pre-seal accepted text", () => {
  const seal = createRendererCommitSeal({ cancel: vi.fn(async () => {}) });
  const event = attempt();
  expect(seal.intercept(event)).toBe(false);
  expect(event.preventDefault).not.toHaveBeenCalled();
  const alreadyAcceptedDraft = "typed before commit";
  seal.seal();
  expect(alreadyAcceptedDraft).toBe("typed before commit");
  seal.release();
});
it("prevents post-receipt input and cancels before any editor handler can accept it", async () => {
  const cancel = vi.fn(async () => {});
  const seal = createRendererCommitSeal({ cancel });
  seal.seal();
  const receipt = { sealed: seal.sealed };
  const event = attempt();
  let text = "checkpointed";
  if (!seal.intercept(event)) text += "lost character";
  expect(receipt.sealed).toBe(true);
  expect(text).toBe("checkpointed");
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  expect(seal.sealed).toBe(true);
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledWith("input-during-commit");
  seal.release();
  expect(seal.intercept(attempt())).toBe(false);
});
it("abort/veto releases the seal so cancel never permanently disables editing", () => {
  const seal = createRendererCommitSeal({ cancel: vi.fn(async () => {}) });
  seal.seal();
  seal.release();
  const event = attempt();
  expect(seal.intercept(event)).toBe(false);
  expect(event.preventDefault).not.toHaveBeenCalled();
});
it("bounded timeout requests cancellation but cannot reopen before native ACK", async () => {
  vi.useFakeTimers();
  let acknowledge!: () => void;
  const cancel = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const seal = createRendererCommitSeal({ cancel, timeoutMs: 15000 });
  seal.seal();
  await vi.advanceTimersByTimeAsync(15000);
  expect(cancel).toHaveBeenCalledWith("commit-seal-timeout");
  expect(seal.sealed).toBe(true);
  acknowledge();
  await vi.advanceTimersByTimeAsync(0);
  expect(seal.sealed).toBe(false);
  expect(seal.intercept(attempt())).toBe(false);
});
it("failed native cancellation keeps edits sealed and allows retry", async () => {
  vi.useFakeTimers();
  const cancellationFailed = vi.fn();
  const cancel = vi.fn(async () => {
    throw new Error("disconnected");
  });
  const seal = createRendererCommitSeal({ cancel, cancellationFailed });
  seal.seal();
  seal.intercept(attempt());
  await vi.advanceTimersByTimeAsync(0);
  expect(seal.sealed).toBe(true);
  expect(cancellationFailed).toHaveBeenCalledOnce();
  seal.intercept(attempt());
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledTimes(2);
  seal.release();
});
