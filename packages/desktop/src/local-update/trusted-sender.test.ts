import { expect, it } from "vitest";
import type { WebContents } from "electron";
import { isTrustedLocalUpdateSender } from "./trusted-sender.js";

it("accepts only exact selected main frame and packaged origin", () => {
  const mainFrame = { url: "paseo://app/index.html" };
  const trusted = { isDestroyed: () => false, mainFrame } as unknown as WebContents;
  expect(isTrustedLocalUpdateSender({ sender: trusted, senderFrame: mainFrame }, trusted)).toBe(
    true,
  );
  expect(isTrustedLocalUpdateSender({ sender: {}, senderFrame: mainFrame }, trusted)).toBe(false);
  expect(
    isTrustedLocalUpdateSender({ sender: trusted, senderFrame: { ...mainFrame } }, trusted),
  ).toBe(false);
  for (const url of [
    "https://app/",
    "paseo://app.evil/",
    "paseo://user@app/",
    "paseo://app:123/",
    "file:///index.html",
  ]) {
    mainFrame.url = url;
    expect(isTrustedLocalUpdateSender({ sender: trusted, senderFrame: mainFrame }, trusted)).toBe(
      false,
    );
  }
  expect(isTrustedLocalUpdateSender(null, undefined)).toBe(false);
});
