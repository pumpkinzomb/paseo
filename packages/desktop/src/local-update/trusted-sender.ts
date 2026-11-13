import type { IpcMainInvokeEvent, WebContents } from "electron";

/** Only the selected packaged app's own main frame, never an embedded browser frame. */
export function isTrustedLocalUpdateSender(
  event: unknown,
  trusted: WebContents | undefined,
): boolean {
  if (!trusted || trusted.isDestroyed()) return false;
  const input = event as Partial<IpcMainInvokeEvent> | null;
  if (!input || input.sender !== trusted || input.senderFrame !== trusted.mainFrame) return false;
  try {
    const url = new URL(input.senderFrame.url);
    return (
      url.protocol === "paseo:" &&
      url.hostname === "app" &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
