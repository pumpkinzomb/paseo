import { expect, it, vi } from "vitest";
import {
  deleteNativeSessionsBeforeRecords,
  type NativeDeletionReceipt,
} from "./native-session-deletion-transaction.js";
const target = { provider: "codex", sessionId: "thread" };
function fixture() {
  let receipt: NativeDeletionReceipt | null = null;
  const events: string[] = [];
  const io = {
    assertIdleAndExclusive: vi.fn(async () => {}),
    read: async () => receipt,
    write: async (_: unknown, state: NativeDeletionReceipt) => {
      receipt = state;
      events.push(state);
    },
    removeNative: vi.fn(async () => {
      events.push("native");
    }),
    removePaseoRecords: vi.fn(async () => {
      events.push("paseo");
    }),
  };
  return { io, events, receipt: () => receipt };
}
it("records intent then native completion before deleting Paseo records", async () => {
  const f = fixture();
  await deleteNativeSessionsBeforeRecords([target], f.io);
  expect(f.events).toEqual(["pending", "native", "deleted", "paseo"]);
});
it("retains records on provider failure and blocks blind retry", async () => {
  const f = fixture();
  f.io.removeNative.mockRejectedValue(Error("lost acknowledgement"));
  await expect(deleteNativeSessionsBeforeRecords([target], f.io)).rejects.toThrow("retained");
  expect(f.receipt()).toBe("pending");
  expect(f.io.removePaseoRecords).not.toHaveBeenCalled();
  await expect(deleteNativeSessionsBeforeRecords([target], f.io)).rejects.toThrow("uncertain");
  expect(f.io.removeNative).toHaveBeenCalledTimes(1);
});
it("does not repeat acknowledged native deletion if Paseo cleanup fails", async () => {
  const f = fixture();
  f.io.removePaseoRecords.mockRejectedValueOnce(Error("local write failed"));
  await expect(deleteNativeSessionsBeforeRecords([target], f.io)).rejects.toThrow("local write");
  await deleteNativeSessionsBeforeRecords([target], f.io);
  expect(f.io.removeNative).toHaveBeenCalledTimes(1);
});
it("refuses busy scopes before any mutation", async () => {
  const f = fixture();
  f.io.assertIdleAndExclusive.mockRejectedValue(Error("busy"));
  await expect(deleteNativeSessionsBeforeRecords([target], f.io)).rejects.toThrow("busy");
  expect(f.events).toEqual([]);
});
