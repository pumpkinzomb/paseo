import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ packaged: true, contents: "{}", fail: false }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return state.packaged;
    },
    getAppPath: () => "/verified/app.asar",
  },
}));
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    if (state.fail) throw new Error("Unreadable package");
    return state.contents;
  }),
}));
import {
  allowsUpstreamAppUpdates,
  allowsUpstreamUpdatesFromPackage,
} from "./app-distribution-policy.js";

describe("packaged distribution policy", () => {
  it("preserves upstream legacy packages", () =>
    expect(allowsUpstreamUpdatesFromPackage({ name: "paseo" })).toBe(true));
  it("allows explicit upstream policy", () =>
    expect(
      allowsUpstreamUpdatesFromPackage({
        paseoDistribution: { schemaVersion: 1, channel: "upstream", updatePolicy: "upstream" },
      }),
    ).toBe(true));
  it.each([
    { schemaVersion: 1, channel: "local", updatePolicy: "local-only" },
    { schemaVersion: 1, channel: "local", updatePolicy: "upstream" },
    { schemaVersion: 2, channel: "upstream", updatePolicy: "upstream" },
    null,
    "upstream",
    {},
  ])("rejects local and unrecognized policy %j", (paseoDistribution) =>
    expect(allowsUpstreamUpdatesFromPackage({ paseoDistribution })).toBe(false),
  );
  it("reads only the packaged metadata and fails closed", () => {
    state.contents = JSON.stringify({
      paseoDistribution: { schemaVersion: 1, channel: "local", updatePolicy: "local-only" },
    });
    expect(allowsUpstreamAppUpdates()).toBe(false);
    state.contents = "{}";
    expect(allowsUpstreamAppUpdates()).toBe(true);
    state.contents = "broken";
    expect(allowsUpstreamAppUpdates()).toBe(false);
    state.fail = true;
    expect(allowsUpstreamAppUpdates()).toBe(false);
    state.fail = false;
    state.packaged = false;
    expect(allowsUpstreamAppUpdates()).toBe(false);
  });
});
