export interface NativeDeletionTarget {
  provider: string;
  sessionId: string;
}
export type NativeDeletionReceipt = "pending" | "deleted";
/**
 * Caller must hold the complete conversation mutation fence.
 * A pending receipt is deliberately not replayed: a provider acknowledgement may
 * have been lost. Reconcile provider state before authorizing another operation.
 */
export async function deleteNativeSessionsBeforeRecords(
  targets: readonly NativeDeletionTarget[],
  io: {
    assertIdleAndExclusive(): Promise<void>;
    read(target: NativeDeletionTarget): Promise<NativeDeletionReceipt | null>;
    write(target: NativeDeletionTarget, state: NativeDeletionReceipt): Promise<void>;
    removeNative(target: NativeDeletionTarget): Promise<void>;
    removePaseoRecords(): Promise<void>;
  },
): Promise<void> {
  await io.assertIdleAndExclusive();
  const keys = targets.map((target) => JSON.stringify([target.provider, target.sessionId]));
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate native deletion target");
  const states = await Promise.all(targets.map((target) => io.read(target)));
  if (states.includes("pending"))
    throw new Error("Native deletion outcome is uncertain; reconcile before retrying.");
  for (let index = 0; index < targets.length; index++) {
    if (states[index] === "deleted") continue;
    await io.assertIdleAndExclusive();
    const target = targets[index]!;
    // Durable intent precedes the irreversible provider operation.
    await io.write(target, "pending");
    try {
      await io.removeNative(target);
      await io.write(target, "deleted");
    } catch (cause) {
      throw new Error("Native deletion may be partially completed; Paseo records were retained.", {
        cause,
      });
    }
  }
  await io.assertIdleAndExclusive();
  await io.removePaseoRecords();
}
