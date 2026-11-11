import { isCheckpointedComposerMeasurementMirror } from "@/composer/input/measurement-mirror";

/** Only the semantic URL editor can reuse its browser's already-checkpointed URL. */
export function isRestorableBrowserUrlInput(
  element: Element,
  browsers: Readonly<Record<string, { url: string }>>,
): boolean {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
    return false;
  const browserId = element.getAttribute("data-update-browser-id");
  return Boolean(
    browserId &&
    element.getAttribute("data-update-browser-url-pristine") === "true" &&
    browsers[browserId]?.url === element.value,
  );
}

export function hasUncheckpointedFormInput(
  document: Document,
  edited: Set<Element>,
  browsers: Readonly<Record<string, { url: string }>>,
  checkpointTexts: ReadonlySet<string> = new Set(),
): boolean {
  for (const input of edited) {
    if (!input.isConnected || isRestorableBrowserUrlInput(input, browsers)) edited.delete(input);
  }
  if (edited.size) return true;
  return Array.from(document.querySelectorAll("input, textarea, [contenteditable=true]")).some(
    (element) => {
      if (isCheckpointedComposerMeasurementMirror(element, checkpointTexts)) return false;
      if (element.closest('[data-testid="message-input-root"]')) return false;
      if (element.hasAttribute("data-update-browser-id"))
        return !isRestorableBrowserUrlInput(element, browsers);
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? Boolean(element.value)
        : Boolean(element.textContent);
    },
  );
}
