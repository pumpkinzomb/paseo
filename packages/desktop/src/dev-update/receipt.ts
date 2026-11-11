const BLOCKER_CODES = new Set([
  "renderer-state-changed",
  "renderer-drafts-changed",
  "renderer-layout-changed",
  "renderer-browser-changed",
  "renderer-workspace-browser-changed",
  "renderer-create-flow-changed",
  "renderer-submission-changed",
  "renderer-attachments-changed",
  "renderer-add-project-changed",
  "renderer-setup-changed",
  "workspace-selection-changed",
  "panel-changed",
  "transient-state-changed",
  "renderer-user-activity",
  "renderer-activity",
  "trusted-input",
  "browser-interaction",
  "browser-created",
  "browser-navigation",
  "browser-unload-veto",
  "browser-download",
  "browser-download-finished",
  "browser-closed",
  "browser-devtools",
  "input-during-commit",
  "commit-seal-timeout",
  "update-canceled",
  "browser-profile-change",
  "browser-capture",
  "browser-copy",
  "native-dialog",
  "browser-automation",
  "browser-profile-change:finished",
  "browser-capture:finished",
  "browser-copy:finished",
  "native-dialog:finished",
  "browser-automation:finished",

  "unsaved-draft-metadata",
  "agent-creation-pending",
  "draft-submission-pending",
  "memory-only-attachments",
  "workspace-transition-or-sheet-open",
  "modified-panel",
  "non-workspace-screen",
  "workspace-setup-pending",
  "recent-user-activity",
  "state-not-hydrated",
  "uncheckpointed-panel-state",
  "dialog-open",
  "uncheckpointed-form-input",
  "dialog-or-sheet-open",
  "modal-open",
  "composer-operation-pending",
  "upload-pending",
  "dictation-or-voice-active",
  "recording-or-upload-pending",
  "checkpoint-changed",
  "checkpoint-not-durable-or-timed-out",
  "renderer-checkpoint-failed",
  "renderer-checkpoint-timeout",
  "invalid-checkpoint-receipt",
  "browser-unknown-guest",
  "browser-devtools-open",
  "browser-loading",
  "browser-download-active",
  "browser-state-not-restorable",
  "browser-media",
  "browser-uninstrumented-frame",
  "unsupported-window-state",
  "native-operation-in-flight",
  "native-checkpoint-error",
  "commit-checkpoint-invalidated",
  "cancelled",
  "controller-aborted",
  "request-changed",
  "quit-vetoed",
  "prepare-expired",
  "window-created",
  "activity-changed",
]);
/** Operational files contain finite codes, never arbitrary renderer text. */
export function safeBlockers(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 64) return ["unknown-checkpoint-blocker"];
  return [
    ...new Set(
      values.map((value) =>
        typeof value === "string" && BLOCKER_CODES.has(value)
          ? value
          : "unknown-checkpoint-blocker",
      ),
    ),
  ];
}
export function safeReceipt(value: unknown, expectedEpoch: number, requireSeal = false) {
  if (!value || typeof value !== "object") return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    (requireSeal && receipt.sealed !== true) ||
    receipt.schemaVersion !== 1 ||
    typeof receipt.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.digest) ||
    !Number.isSafeInteger(expectedEpoch) ||
    expectedEpoch < 0 ||
    !Number.isSafeInteger(receipt.activityEpoch) ||
    receipt.activityEpoch !== expectedEpoch ||
    typeof receipt.capturedAt !== "number" ||
    !Number.isSafeInteger(receipt.capturedAt) ||
    receipt.capturedAt <= 0 ||
    (receipt.revision !== undefined &&
      (!Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 0))
  )
    return undefined;
  return {
    schemaVersion: 1,
    digest: receipt.digest,
    activityEpoch: expectedEpoch,
    capturedAt: receipt.capturedAt,
    ...(requireSeal ? { sealed: true } : {}),
  };
}
