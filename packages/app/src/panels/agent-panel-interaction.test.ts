import { describe, expect, it } from "vitest";
import { resolveAgentPanelInteraction } from "./agent-panel-interaction";

describe("history sheet interaction", () => {
  it.each([true, false])(
    "keeps archived-workspace history read-only even with archived=%s",
    (archived) => {
      expect(
        resolveAgentPanelInteraction({
          paneHost: "sheet",
          isDraft: false,
          archived,
          archiving: false,
        }),
      ).toEqual({ showsComposer: false, hasActiveComposer: false, fileDropDisabled: true });
    },
  );
});
