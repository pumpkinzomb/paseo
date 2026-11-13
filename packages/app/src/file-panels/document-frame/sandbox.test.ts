import { describe, expect, it } from "vitest";
import { documentFrameSandbox } from "./sandbox";

describe("document frame sandbox", () => {
  it("identifies PDFs for the app-owned renderer", () => {
    expect(documentFrameSandbox("application/pdf")).toBeNull();
    expect(documentFrameSandbox("Application/PDF; charset=binary")).toBeNull();
  });

  it.each(["text/html", "application/octet-stream", "unknown", "", null, undefined])(
    "keeps %s fully sandboxed",
    (mediaType) => {
      expect(documentFrameSandbox(mediaType)).toBe("");
    },
  );
});
