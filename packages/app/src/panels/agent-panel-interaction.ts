import type { PaneHost } from "./panel-manifest";

/** Sheets only inspect history, even when the archived workspace's agent was not archived. */
export function resolveAgentPanelInteraction(input: {
  paneHost: PaneHost;
  isDraft: boolean;
  archived: boolean;
  archiving: boolean;
}) {
  const showsComposer = input.isDraft || input.paneHost !== "sheet";
  return {
    showsComposer,
    hasActiveComposer: showsComposer && !input.archived && !input.archiving,
    fileDropDisabled: !showsComposer || input.archiving,
  };
}
