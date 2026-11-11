import { expect, it } from "vitest";
import { collectStoreUpdateBlockers } from "./blockers";
const idle = {
  metadataByDraftKey: {},
  pendingCreateByDraftId: {},
  pendingSubmissionByDraftId: {},
  creationByDraftId: {},
  setupByDraftId: {},
  attachmentsByScope: {},
  pendingOpenByWorkspace: {},
  sheetsByWorkspace: {},
  modifiedPanelCount: 0,
};
it("admits idle stores without requiring empty durable draft text", () => {
  expect(collectStoreUpdateBlockers(idle)).toEqual([]);
});
it.each([
  ["metadataByDraftKey", { draft: { plugin: "unsaved" } }, "unsaved-draft-metadata"],
  ["pendingCreateByDraftId", { draft: {} }, "agent-creation-pending"],
  ["pendingSubmissionByDraftId", { draft: {} }, "draft-submission-pending"],
  ["creationByDraftId", { draft: {} }, "draft-submission-pending"],
  ["setupByDraftId", { draft: {} }, "draft-submission-pending"],
  ["attachmentsByScope", { draft: [{}] }, "memory-only-attachments"],
  ["pendingOpenByWorkspace", { workspace: {} }, "workspace-transition-or-sheet-open"],
  ["sheetsByWorkspace", { hiddenWorkspace: [{}] }, "workspace-transition-or-sheet-open"],
  ["modifiedPanelCount", 1, "modified-panel"],
])("blocks %s without exposing its contents", (key, value, reason) => {
  expect(collectStoreUpdateBlockers({ ...idle, [key as string]: value })).toEqual([reason]);
});
