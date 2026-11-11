import { describe, expect, test } from "vitest";
import {
  getPanelInstanceAttributes,
  setPanelInstanceAttributes,
  subscribePanelInstanceAttributes,
} from "./panel-instance-attributes";

describe("panel instance attributes", () => {
  test("keeps runtime attributes isolated by workspace and tab", () => {
    const first = { serverId: "server", workspaceId: "one", tabId: "tab" };
    const second = { serverId: "server", workspaceId: "two", tabId: "tab" };

    setPanelInstanceAttributes(first, { modified: true });

    expect(getPanelInstanceAttributes(first)).toEqual({ modified: true });
    expect(getPanelInstanceAttributes(second)).toEqual({ modified: false });

    setPanelInstanceAttributes(first, { modified: false });
  });

  test("notifies subscribers only when attributes change", () => {
    const identity = { serverId: "server", workspaceId: "workspace", tabId: "observed" };
    let notifications = 0;
    const unsubscribe = subscribePanelInstanceAttributes(identity, () => {
      notifications += 1;
    });

    setPanelInstanceAttributes(identity, { modified: true });
    setPanelInstanceAttributes(identity, { modified: true });
    setPanelInstanceAttributes(identity, { modified: false });

    expect(notifications).toBe(2);
    unsubscribe();
  });
});

test("aggregate checkpoint sees modified panels in every workspace and invalidates on change", async () => {
  const { getModifiedPanelCheckpoint, subscribeAllPanelInstanceAttributes } =
    await import("./panel-instance-attributes");
  const before = getModifiedPanelCheckpoint();
  const identity = { serverId: "other-host", workspaceId: "hidden", tabId: "editor" };
  let notifications = 0;
  const unsubscribe = subscribeAllPanelInstanceAttributes(() => {
    notifications++;
  });
  setPanelInstanceAttributes(identity, { modified: true });
  expect(getModifiedPanelCheckpoint()).toEqual({
    revision: before.revision + 1,
    count: before.count + 1,
  });
  setPanelInstanceAttributes(identity, { modified: false });
  expect(getModifiedPanelCheckpoint()).toEqual({
    revision: before.revision + 2,
    count: before.count,
  });
  expect(notifications).toBe(2);
  unsubscribe();
});
