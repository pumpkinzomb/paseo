import { describe, it, expect, vi } from "vitest";
import { openLeadIdentityForm } from "./lead-identity-form-model";
describe("lead identity editor", () => {
  it("seeds each open independently and preserves edits after failure", async () => {
    const model = openLeadIdentityForm("original");
    model.setText("edited");
    await model.save(async () => {
      throw new Error("offline");
    });
    expect(model.getState()).toMatchObject({
      text: "edited",
      saved: "original",
      saving: false,
      error: "failed",
    });
    expect(openLeadIdentityForm("latest").getState().text).toBe("latest");
  });
  it("saves once during repeated clicks and resets to the returned effective default", async () => {
    const model = openLeadIdentityForm("original");
    model.setText("edited");
    let resolve!: (text: string) => void;
    const persist = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const pending = model.save(persist);
    await model.save(persist);
    model.setText("ignored while saving");
    expect(persist).toHaveBeenCalledTimes(1);
    resolve("edited");
    await pending;
    expect(model.getState()).toMatchObject({ text: "edited", saved: "edited", savedNotice: true });
    const reset = vi.fn(async () => "default");
    await model.save(reset, true);
    expect(reset).toHaveBeenCalledWith("", "edited");
    expect(model.getState().text).toBe("default");
  });
  it("rejects invalid input and reports a concurrent edit without overwriting", async () => {
    const model = openLeadIdentityForm("original");
    const persist = vi.fn(async () => "bad");
    model.setText("  ");
    await model.save(persist);
    expect(persist).not.toHaveBeenCalled();
    model.setText("a".repeat(12001));
    await model.save(persist);
    expect(persist).not.toHaveBeenCalled();
    model.setText("valid");
    await model.save(async () => {
      throw new Error("conflict");
    });
    expect(model.getState()).toMatchObject({ text: "valid", saved: "original", error: "conflict" });
  });
});
