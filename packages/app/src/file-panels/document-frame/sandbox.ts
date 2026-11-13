/** A PDF marker selects the app-owned sandboxed PDF.js renderer on web.
 * Other media stays in a fully sandboxed frame; this marker does not grant
 * document content same-origin access or permission to run PDF scripts.
 */
export function documentFrameSandbox(mediaType: string | null | undefined): string | null {
  return mediaType?.split(";")[0].trim().toLowerCase() === "application/pdf" ? null : "";
}
