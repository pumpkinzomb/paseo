/** @vitest-environment jsdom */
import React from "react";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  getUpdateTransientBlockers,
  subscribeUpdateTransientState,
  useUpdateTransientBlocker,
} from "./transient-state";
function Pending({ active }: { active: boolean }) {
  useUpdateTransientBlocker("upload-pending", active);
  return null;
}
it("blocks mounted pending work and invalidates on admission and completion", () => {
  vi.stubGlobal("React", React);
  let changes = 0;
  const unsubscribe = subscribeUpdateTransientState(() => {
    changes++;
  });
  const view = render(<Pending active />);
  expect(getUpdateTransientBlockers()).toEqual(["upload-pending"]);
  view.rerender(<Pending active={false} />);
  expect(getUpdateTransientBlockers()).toEqual([]);
  expect(changes).toBe(2);
  view.unmount();
  unsubscribe();
});
