import { expect, it } from "vitest";
import {
  DEFAULT_PDF_PREFERENCES,
  effectiveThumbnailWidth,
  parsePdfPreferences,
  thumbnailWidth,
} from "./model";
it("starts narrow and leaves most width for the document", () => {
  expect(effectiveThumbnailWidth(DEFAULT_PDF_PREFERENCES, 640)).toBe(110);
  expect(effectiveThumbnailWidth({ width: 240, collapsed: false }, 400)).toBe(140);
});
it("collapses only the effective width on narrow screens, preserving preference", () => {
  expect(effectiveThumbnailWidth(DEFAULT_PDF_PREFERENCES, 320)).toBe(0);
  expect(DEFAULT_PDF_PREFERENCES.width).toBe(110);
  expect(effectiveThumbnailWidth({ width: 110, collapsed: true }, 900)).toBe(0);
});
it("validates persisted preferences and bounds drag widths", () => {
  expect(parsePdfPreferences({ width: NaN, collapsed: false })).toBeNull();
  expect(parsePdfPreferences({ width: 100, collapsed: "false" })).toBeNull();
  expect(parsePdfPreferences({ width: 900, collapsed: false })).toEqual({
    width: 240,
    collapsed: false,
  });
  expect(thumbnailWidth(-100)).toBe(72);
});
