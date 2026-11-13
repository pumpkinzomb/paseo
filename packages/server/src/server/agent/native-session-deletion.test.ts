import { expect, it } from "vitest";
import { planNativeSessionDeletion } from "./native-session-deletion.js";
const record = (id: string, sessionId = "native") => ({
  id,
  provider: "codex",
  persistence: { provider: "codex", sessionId },
});
it("deduplicates exact native sessions across selected model segments", () => {
  expect(planNativeSessionDeletion(["a", "b"], [record("a"), record("b")])).toEqual([
    { provider: "codex", sessionId: "native", agentIds: ["a", "b"] },
  ]);
});
it("blocks a native session referenced by an unselected conversation", () => {
  expect(() => planNativeSessionDeletion(["a"], [record("a"), record("b")])).toThrow("shared");
});
it("blocks changed scope and unsupported providers", () => {
  expect(() => planNativeSessionDeletion(["missing"], [])).toThrow("scope");
  expect(() =>
    planNativeSessionDeletion(
      ["a"],
      [
        {
          id: "a",
          provider: "other",
          persistence: { provider: "other", sessionId: "x" },
        },
      ],
    ),
  ).toThrow("unsupported");
});
it("does not invent native sessions for conversations that never started", () => {
  expect(planNativeSessionDeletion(["a"], [{ id: "a", provider: "claude" }])).toEqual([]);
});
