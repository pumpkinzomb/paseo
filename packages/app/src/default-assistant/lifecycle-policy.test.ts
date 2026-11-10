import { describe, expect, it } from "vitest";
import { assistantLifecycleActions, assistantLifecycleBusy } from "./lifecycle-policy";
describe("assistant lifecycle UI policy", () => {
  it("offers recovery rather than another archive for archived conversations", () => {
    expect(assistantLifecycleActions(true)).toEqual(["restore", "delete"]);
    expect(assistantLifecycleActions(false)).toEqual(["archive", "delete"]);
  });
  it("protects active work; server checks every segment independently", () => {
    expect(assistantLifecycleBusy("running")).toBe(true);
    expect(assistantLifecycleBusy("initializing")).toBe(true);
    expect(assistantLifecycleBusy("idle")).toBe(false);
  });
});
