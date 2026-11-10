import { describe, expect, it } from "vitest";
import { buildAssistantHandoffDraft, buildContinuedAssistantHandoffDraft } from "./handoff-draft";
const entry = (type: string, text: string) => ({ item: { type, text } });
describe("assistant handoff drafts", () => {
  it("includes only visible conversation prose in order", () => {
    const draft = buildAssistantHandoffDraft([
      entry("user_message", "Make the sidebar smaller."),
      entry("reasoning", "private reasoning"),
      entry("tool_call", "tool output"),
      entry("assistant_message", "The sidebar is now smaller."),
    ]);
    expect(draft.text).toBe(
      "User:\nMake the sidebar smaller.\n\nAssistant:\nThe sidebar is now smaller.",
    );
    expect(draft.omittedMessages).toBe(2);
  });
  it("omits internal instructions and likely secrets entirely", () => {
    const draft = buildAssistantHandoffDraft([
      entry("user_message", '<paseo-system kind="agent-message">internal</paseo-system>'),
      entry("user_message", "api_key=sk-proj-12345678901234567890"),
      entry("assistant_message", "Authorization: Bearer abcdefghijklmnop"),
      entry("user_message", "My card: 4242 4242 4242 4242"),
      entry("user_message", "Keep the original conversation."),
    ]);
    expect(draft.sensitiveMessages).toBe(3);
    expect(draft.omittedMessages).toBe(4);
    expect(draft.text).toBe("User:\nKeep the original conversation.");
  });
  it("bounds long history and keeps the newest content", () => {
    const draft = buildAssistantHandoffDraft([
      entry("user_message", "a".repeat(20_000)),
      entry("assistant_message", "Latest decision"),
    ]);
    expect(draft.text.length).toBeLessThanOrEqual(12_000);
    expect(draft.text.endsWith("Assistant:\nLatest decision")).toBe(true);
    expect(draft.truncated).toBe(true);
  });
  it("handles empty and tiny budgets without exceeding bounds", () => {
    expect(buildAssistantHandoffDraft([]).text).toBe("");
    expect(buildAssistantHandoffDraft([entry("user_message", "Longer message")], 3).text).toBe("");
    expect(buildAssistantHandoffDraft([entry("user_message", "x")], 0).truncated).toBe(true);
  });
});

describe("continued reviewed handoff", () => {
  it("keeps the previous approved context even before any new message", () => {
    expect(buildContinuedAssistantHandoffDraft([], "Only the approved decision").text).toBe(
      "Only the approved decision",
    );
  });
  it("combines only the current approved reference and safe current prose", () => {
    const draft = buildContinuedAssistantHandoffDraft(
      [
        entry("user_message", "Continue with the implementation"),
        entry("tool_call", "Never resend raw tool output"),
      ],
      "Keep Y only",
    );
    expect(draft.text).toBe(
      "Keep Y only\n\n[Current conversation]\nUser:\nContinue with the implementation",
    );
    expect(draft.omittedMessages).toBe(1);
  });
  it("preserves the reference and flags recent-message truncation within the total budget", () => {
    const context = "a".repeat(11990);
    const draft = buildContinuedAssistantHandoffDraft(
      [entry("user_message", "Very recent message")],
      context,
    );
    expect(draft.text).toBe(context);
    expect(draft.truncated).toBe(true);
    expect(draft.text.length).toBeLessThanOrEqual(12000);
  });
  it("does not invent a legacy handoff", () => {
    const entries = [entry("user_message", "Visible current text")];
    expect(buildContinuedAssistantHandoffDraft(entries)).toEqual(
      buildAssistantHandoffDraft(entries),
    );
  });
});
