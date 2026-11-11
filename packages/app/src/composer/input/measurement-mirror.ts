// Private node identity, not a DOM attribute: only the composer measurement path
// can register its derived mirror. The source text must also belong to the draft
// snapshot whose backing storage is verified before a checkpoint is accepted.
const mirrors = new WeakMap<Element, { source: HTMLElement; text: string }>();

export function registerComposerMeasurementMirror(
  mirror: HTMLTextAreaElement,
  source: HTMLElement,
  text: string,
): void {
  mirrors.set(mirror, { source, text });
}

export function isCheckpointedComposerMeasurementMirror(
  element: Element,
  checkpointTexts: ReadonlySet<string>,
): boolean {
  const owned = mirrors.get(element);
  if (!owned || !(element instanceof HTMLTextAreaElement)) return false;
  const { source, text } = owned;
  return Boolean(
    element.isConnected &&
    source.isConnected &&
    source instanceof HTMLTextAreaElement &&
    source.closest('[data-testid="message-input-root"]') &&
    element.readOnly &&
    element.getAttribute("aria-hidden") === "true" &&
    source.value === text &&
    checkpointTexts.has(text) &&
    element.value === (text.endsWith("\n") ? `${text} ` : text),
  );
}
