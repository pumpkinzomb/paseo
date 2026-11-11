/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { hasUncheckpointedFormInput } from "./browser-url-input";
afterEach(() => document.body.replaceChildren());
function urlInput(value = "https://example.com/") {
  const input = document.createElement("input");
  input.setAttribute("data-update-browser-id", "browser-one");
  input.setAttribute("data-update-browser-url-pristine", "true");
  input.value = value;
  document.body.append(input);
  return input;
}
const browsers = { "browser-one": { url: "https://example.com/" } };
it("accepts only the pristine exact URL restored by the identified browser store", () => {
  urlInput();
  expect(hasUncheckpointedFormInput(document, new Set(), browsers)).toBe(false);
});
it("blocks edited or cleared URL text, including before React updates its pristine marker", () => {
  const input = urlInput();
  input.value = "https://unsaved.example/";
  const edited = new Set<Element>([input]);
  expect(hasUncheckpointedFormInput(document, edited, browsers)).toBe(true);
  input.value = "";
  expect(hasUncheckpointedFormInput(document, edited, browsers)).toBe(true);
});
it("clears edited tracking only after legitimate navigation restores the canonical URL and draft", () => {
  const input = urlInput("https://next.example/");
  const edited = new Set<Element>([input]);
  input.setAttribute("data-update-browser-url-pristine", "false");
  const next = { "browser-one": { url: "https://next.example/" } };
  expect(hasUncheckpointedFormInput(document, edited, next)).toBe(true);
  input.setAttribute("data-update-browser-url-pristine", "true");
  expect(hasUncheckpointedFormInput(document, edited, next)).toBe(false);
  expect(edited.size).toBe(0);
});
it("never exempts other fields or an unknown browser ID", () => {
  const input = urlInput();
  expect(hasUncheckpointedFormInput(document, new Set(), {})).toBe(true);
  input.removeAttribute("data-update-browser-id");
  expect(hasUncheckpointedFormInput(document, new Set(), browsers)).toBe(true);
});

it("accepts only a registered measurement mirror of a live managed persisted composer", async () => {
  const { registerComposerMeasurementMirror } = await import("@/composer/input/measurement-mirror");
  const root = document.createElement("div");
  root.dataset.testid = "message-input-root";
  const source = document.createElement("textarea");
  source.value = "saved draft\n";
  root.append(source);
  const mirror = document.createElement("textarea");
  mirror.readOnly = true;
  mirror.setAttribute("aria-hidden", "true");
  mirror.value = "saved draft\n ";
  document.body.append(root, mirror);
  const texts = new Set([source.value]);
  expect(hasUncheckpointedFormInput(document, new Set(), {}, texts)).toBe(true);
  registerComposerMeasurementMirror(mirror, source, source.value);
  expect(hasUncheckpointedFormInput(document, new Set(), {}, texts)).toBe(false);
  expect(hasUncheckpointedFormInput(document, new Set(), {}, new Set())).toBe(true);
  mirror.value = "unowned new text";
  expect(hasUncheckpointedFormInput(document, new Set(), {}, texts)).toBe(true);
  mirror.value = "saved draft\n ";
  source.remove();
  expect(hasUncheckpointedFormInput(document, new Set(), {}, texts)).toBe(true);
});

it("keeps unknown readonly hidden fields blocked even when their text matches a saved draft", () => {
  const field = document.createElement("textarea");
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.value = "saved draft";
  document.body.append(field);
  expect(hasUncheckpointedFormInput(document, new Set(), {}, new Set([field.value]))).toBe(true);
});
