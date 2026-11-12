// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearResidentBrowserWebviewsForTests,
  ensureResidentBrowserWebview,
  presentBrowserWebview,
  prepareBrowserWebview,
  resizeResidentBrowserWebview,
  releaseResidentBrowserWebview,
} from "./resident-webviews";

const profileHost = {
  profilePartition: "persist:browser-inline-test",
  registerAttachedBrowser: async () => {},
};
afterEach(() => {
  clearResidentBrowserWebviewsForTests();
  document.body.replaceChildren();
});

describe("browser panel DOM containment", () => {
  it("keeps a white browser canvas through attachment, presentation, resize and parking", () => {
    const fresh = document.createElement("webview");
    prepareBrowserWebview(fresh, {
      browserId: "fresh-canvas",
      workspaceId: "workspace",
      initialUrl: "https://example.com",
      profileHost,
    });
    expect(fresh.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(fresh.getAttribute("webpreferences")).toBe("transparent=no");

    const clip = document.createElement("div");
    const anchor = document.createElement("div");
    anchor.style.background = "#181818";
    clip.appendChild(anchor);
    document.body.appendChild(clip);
    const webview = ensureResidentBrowserWebview({
      browserId: "canvas",
      workspaceId: "workspace",
      url: "https://example.com",
      profileHost,
    })!;
    expect(webview.style.backgroundColor).toBe("rgb(255, 255, 255)");
    presentBrowserWebview("canvas", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(webview.style.backgroundColor).toBe("rgb(255, 255, 255)");
    resizeResidentBrowserWebview({
      browserId: "canvas",
      width: 640,
      height: 480,
    });
    expect(webview.style.backgroundColor).toBe("rgb(255, 255, 255)");
    releaseResidentBrowserWebview("canvas", webview);
    expect(webview.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(anchor.style.backgroundColor).toBe("rgb(24, 24, 24)");
  });

  it("uses panel layout without reading screen coordinates or moving the guest on updates", () => {
    const clip = document.createElement("div");
    const anchor = document.createElement("div");
    clip.appendChild(anchor);
    document.body.appendChild(clip);
    const rect = vi.spyOn(anchor, "getBoundingClientRect");
    const clipRect = vi.spyOn(clip, "getBoundingClientRect");
    const webview = ensureResidentBrowserWebview({
      browserId: "inline",
      workspaceId: "workspace",
      url: "https://example.com",
      profileHost,
    })!;
    presentBrowserWebview("inline", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(webview.parentElement).toBe(anchor);
    expect(webview.style.position).toBe("");
    expect(webview.style.width).toBe("100%");
    expect(webview.style.height).toBe("100%");
    expect(clip.style.contain).toBe("paint");
    const reattach = vi.spyOn(anchor, "appendChild");
    // Hiding/revealing the retained page and moving the panel must not reparent it.
    clip.style.display = "none";
    clip.style.display = "flex";
    clip.style.marginLeft = "180px";
    presentBrowserWebview("inline", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(reattach).not.toHaveBeenCalled();
    expect(rect).not.toHaveBeenCalled();
    expect(clipRect).not.toHaveBeenCalled();
    expect(
      ensureResidentBrowserWebview({
        browserId: "inline",
        workspaceId: "workspace",
        url: "https://example.com",
        profileHost,
      }),
    ).toBe(webview);
    expect(webview.parentElement).toBe(anchor);
  });

  it("keeps device viewport sizing inside the local clip and parks on unmount only", () => {
    const clip = document.createElement("div");
    const anchor = document.createElement("div");
    clip.appendChild(anchor);
    document.body.appendChild(clip);
    const webview = ensureResidentBrowserWebview({
      browserId: "fixed",
      workspaceId: "workspace",
      url: "https://example.com",
      profileHost,
    })!;
    presentBrowserWebview("fixed", webview, anchor, clip, {
      mode: "fixed",
      width: 1280,
      height: 800,
    });
    expect(webview.parentElement).toBe(anchor);
    expect(webview.style.width).toBe("1280px");
    expect(webview.style.height).toBe("800px");
    expect(clip.style.overflow).toBe("hidden");
    releaseResidentBrowserWebview("fixed", webview);
    expect(webview.parentElement).not.toBe(anchor);
    expect(webview.isConnected).toBe(true);
    expect(webview.parentElement?.getAttribute("aria-hidden")).toBe("true");
  });
});
