/** Counts only; no draft text, metadata values or attachment contents leave the stores. */
export function collectStoreUpdateBlockers(state: {
  metadataByDraftKey: Record<string, unknown>;
  pendingCreateByDraftId: Record<string, unknown>;
  pendingSubmissionByDraftId: Record<string, unknown>;
  creationByDraftId: Record<string, unknown>;
  setupByDraftId: Record<string, unknown>;
  attachmentsByScope: Record<string, readonly unknown[]>;
  pendingOpenByWorkspace: Record<string, unknown>;
  sheetsByWorkspace: Record<string, readonly unknown[]>;
  modifiedPanelCount: number;
}): string[] {
  const blockers: string[] = [];
  if (Object.keys(state.metadataByDraftKey).length) blockers.push("unsaved-draft-metadata");
  if (Object.keys(state.pendingCreateByDraftId).length) blockers.push("agent-creation-pending");
  if (
    Object.keys(state.pendingSubmissionByDraftId).length ||
    Object.keys(state.creationByDraftId).length ||
    Object.keys(state.setupByDraftId).length
  )
    blockers.push("draft-submission-pending");
  if (Object.values(state.attachmentsByScope).some((items) => items.length))
    blockers.push("memory-only-attachments");
  if (
    Object.keys(state.pendingOpenByWorkspace).length ||
    Object.values(state.sheetsByWorkspace).some((sheets) => sheets.length)
  )
    blockers.push("workspace-transition-or-sheet-open");
  if (state.modifiedPanelCount) blockers.push("modified-panel");
  return blockers;
}
