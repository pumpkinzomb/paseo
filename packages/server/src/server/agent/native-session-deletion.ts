/** Pure preflight: no provider files or Paseo records are changed here. */
export interface NativeDeletionRecord {
  id: string;
  provider: string;
  persistence?: { provider: string; sessionId: string; nativeHandle?: unknown } | null;
}
export function planNativeSessionDeletion(
  selectedIds: readonly string[],
  records: readonly NativeDeletionRecord[],
): Array<{ provider: "codex" | "claude"; sessionId: string; agentIds: string[] }> {
  const selected = new Set(selectedIds);
  if (
    selected.size !== selectedIds.length ||
    [...selected].some((id) => !records.some((record) => record.id === id))
  )
    throw new Error("Deletion scope changed. Review the conversation again.");
  const targets = new Map<
    string,
    { provider: "codex" | "claude"; sessionId: string; agentIds: string[] }
  >();
  for (const record of records) {
    if (!selected.has(record.id) || !record.persistence) continue;
    const { provider } = record.persistence;
    const sessionId = record.persistence.nativeHandle ?? record.persistence.sessionId;
    if (
      !["codex", "claude"].includes(provider) ||
      provider !== record.provider ||
      typeof sessionId !== "string" ||
      !sessionId.trim()
    )
      throw new Error("Native session deletion is unsupported for this record.");
    const key = JSON.stringify([provider, sessionId]);
    if (
      records.some(
        (other) =>
          !selected.has(other.id) &&
          other.persistence?.provider === provider &&
          (other.persistence.nativeHandle ?? other.persistence.sessionId) === sessionId,
      )
    )
      throw new Error("Native session is shared with another conversation.");
    const target = targets.get(key) ?? {
      provider: provider as "codex" | "claude",
      sessionId,
      agentIds: [],
    };
    target.agentIds.push(record.id);
    targets.set(key, target);
  }
  return [...targets.values()];
}
